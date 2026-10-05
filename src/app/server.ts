#!/usr/bin/env node
// Local listing picker: npm run app → http://localhost:4310
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";

import { loadEnv, requireKeys, resolveModels } from "../config.js";
import { logContext, progressContext, type Progress } from "../files.js";
import { addListingPhoto, createListing, duplicateListing, deleteListing, restoreListing, updateListingDetails, listingDir, listListings, LISTINGS_DIR, readListing, saveListingOrder, saveSelection, type Listing } from "../listing/listing.js";
import { listProfiles, listRuns, loadProfile, runListingRedesign, RUNS_DIR, type RunSummary } from "../redesign/job.js";
import type { PhotoResult } from "../redesign/run.js";
import { renderReport } from "../report.js";
import { pdfFilename, renderReportPdf, type PdfDetail } from "../report-pdf.js";
import { TIERS } from "../redesign/tiers.js";
import { runTasteBuild } from "../taste/build.js";
import { TasteProfile } from "../taste/schema.js";
import {
  addReference,
  createTasteProfile,
  deleteTasteProfile,
  restoreTasteProfile,
  listTasteProfiles,
  PROFILES_DIR,
  profileDir,
  profileJsonPath,
  readTasteProfile,
  removeReference,
  renameTasteProfile,
  restorePreviousProfile,
  restoreReference,
  saveBrief,
  saveProfileJson,
  saveTasteProfileOrder,
} from "../taste/store.js";

const PORT = Number(process.env.PORT ?? 4310);
// Listen on the LAN so the app can be opened from another device on the same Wi-Fi.
const HOST = "0.0.0.0";
const INDEX = path.join(path.dirname(new URL(import.meta.url).pathname), "index.html");

function isAllowedRequestHost(host: string): boolean {
  if (/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(:\d+)?$/.exec(host);
  if (!match) return false;
  const [a, b, c, d] = match.slice(1, 5).map(Number) as [number, number, number, number];
  if ([a, b, c, d].some((octet) => octet > 255)) return false;
  const privateIpv4 = a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
  const tailscaleIpv4 = a === 100 && b >= 64 && b <= 127;
  return privateIpv4 || tailscaleIpv4;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".txt": "text/plain; charset=utf-8",
};

type Job = {
  id: string;
  kind: "redesign" | "taste";
  key: string; // listing id or profile id
  status: "running" | "done" | "error";
  startedAt: number;
  log: string[];
  progress: Progress;
  run: RunSummary | null;
  error: string | null;
};
const jobs = new Map<string, Job>();
/** One running job per listing or profile; different ones run in parallel. */
const activeJobs = new Map<string, Job>();
const jobKey = (kind: Job["kind"], key: string) => `${kind}:${key}`;

function startJob(kind: Job["kind"], key: string, work: () => Promise<RunSummary | unknown>): Job {
  const job: Job = {
    id: randomUUID(), kind, key, status: "running", startedAt: Date.now(), log: [],
    progress: { total: 0, done: 0, label: "Starting…" }, run: null, error: null,
  };
  jobs.set(job.id, job);
  activeJobs.set(jobKey(kind, key), job);
  const sink = (message: string) => job.log.push(`${new Date().toLocaleTimeString()}  ${message}`);
  logContext
    .run(sink, () => progressContext.run(job.progress, work))
    .then((result) => {
      job.status = "done";
      job.progress.done = job.progress.total;
      job.progress.label = "Finished";
      if (kind === "redesign") job.run = result as RunSummary;
    })
    .catch((error) => Object.assign(job, { status: "error", error: error instanceof Error ? error.message : String(error) }));
  return job;
}

function isRunning(kind: Job["kind"], key: string): boolean {
  return activeJobs.get(jobKey(kind, key))?.status === "running";
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readRaw(req: IncomingMessage, limit: number): Promise<Buffer> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error(`File too large (max ${Math.round(limit / 1e6)} MB)`), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256_000) throw Object.assign(new Error("Body too large"), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

/** Resolve a URL path segment under a base dir, refusing anything that escapes it. */
function safeJoin(base: string, relative: string): string | null {
  const full = path.resolve(base, decodeURIComponent(relative));
  return full.startsWith(base + path.sep) ? full : null;
}

async function sendFile(res: ServerResponse, file: string | null) {
  if (!file || !existsSync(file) || !(await stat(file)).isFile()) return send(res, 404, { error: "Not found" });
  res.writeHead(200, { "content-type": CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-cache" });
  res.end(await readFile(file));
}

const thumbCache = new Map<string, Buffer>();
async function sendThumb(res: ServerResponse, file: string | null, width: number) {
  if (!file || !existsSync(file)) return send(res, 404, { error: "Not found" });
  const { mtimeMs } = await stat(file);
  const key = `${file}:${width}:${mtimeMs}`;
  let thumb = thumbCache.get(key);
  if (!thumb) {
    thumb = await sharp(file).rotate().resize({ width, withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
    thumbCache.set(key, thumb);
  }
  res.writeHead(200, { "content-type": "image/webp", "cache-control": "max-age=3600" });
  res.end(thumb);
}

function listingJson(listing: Listing, runs: RunSummary[]) {
  return {
    id: listing.id,
    name: listing.name,
    source: listing.source,
    location: listing.location,
    description: listing.description,
    photos: listing.photos.map((p) => ({
      ...p,
      thumb: `/thumb/listings/${listing.id}/${encodeURIComponent(p.file)}?w=640`,
      full: `/files/listings/${listing.id}/${encodeURIComponent(p.file)}`,
    })),
    runs: runs.map((r) => ({ ...r, reportUrl: r.report ? `/files/runs/${listing.id}/${r.id}/${r.report}` : null })),
    activeJob: activeJobs.has(jobKey("redesign", listing.id)) ? jobView(activeJobs.get(jobKey("redesign", listing.id))!) : null,
  };
}

function jobView(job: Job) {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    startedAt: job.startedAt,
    progress: { total: job.progress.total, done: job.progress.done, label: job.progress.label },
    stopping: !!job.progress.cancelled && job.status === "running",
    log: job.log.slice(-200),
    error: job.error,
    reportUrl: job.run?.report ? `/files/runs/${job.key}/${job.run.id}/${job.run.report}` : null,
  };
}

async function tasteProfileJson(id: string) {
  const stored = await readTasteProfile(id);
  if (!stored) return null;
  const active = activeJobs.get(jobKey("taste", id));
  return {
    ...stored,
    references: stored.references.map((file) => ({
      file,
      thumb: `/thumb/profiles/${id}/references/${encodeURIComponent(file)}?w=480`,
      full: `/files/profiles/${id}/references/${encodeURIComponent(file)}`,
    })),
    activeJob: active ? jobView(active) : null,
  };
}

/** What a run's report is drawn from: its saved results plus the listing and profile as they are now. */
async function loadReportInput(runDir: string) {
  const resultsPath = path.join(runDir, "results.json");
  const runPath = path.join(runDir, "run.json");
  if (!existsSync(resultsPath) || !existsSync(runPath)) return null;
  const run = JSON.parse(await readFile(runPath, "utf8")) as RunSummary;
  const listing = await readListing(listingDir(run.listing)).catch(() => null);
  const profile = await loadProfile(run.profile).catch(() => null);
  const profileName = (await listRuns(run.listing)).find((r) => r.id === path.basename(runDir))?.profileName ?? null;
  return {
    listingId: run.listing,
    title: listing?.name ?? run.listing,
    photos: JSON.parse(await readFile(resultsPath, "utf8")) as PhotoResult[],
    profileSummary: profile?.summary ?? "",
    location: listing?.location ?? null,
    run: { startedAt: run.startedAt, profileName, stopped: !!run.stopped },
  };
}

/** Re-render a run's report from its saved results so past runs pick up report improvements. */
async function freshReport(runDir: string): Promise<string | null> {
  try {
    const input = await loadReportInput(runDir);
    if (!input) return null;
    const pdfBase = `/pdf/runs/${path.relative(RUNS_DIR, runDir).split(path.sep).map(encodeURIComponent).join("/")}`;
    return renderReport({
      ...input,
      backHref: `/?listing=${encodeURIComponent(input.listingId)}`,
      pdf: { summary: `${pdfBase}?detail=summary`, full: `${pdfBase}?detail=full` },
    });
  } catch {
    return null; // fall back to the static file written at run time
  }
}

/** A run's report as a PDF to share: /pdf/runs/<listing>/<run>?detail=summary|full */
async function sendReportPdf(res: ServerResponse, runDir: string | null, detail: string | null) {
  const input = runDir ? await loadReportInput(runDir) : null;
  if (!runDir || !input) return send(res, 404, { error: "Report not found" });
  const level: PdfDetail = detail === "full" ? "full" : "summary";
  const pdf = await renderReportPdf({ ...input, runDir, detail: level });
  const name = pdfFilename(input.title, level);
  res.writeHead(200, {
    "content-type": "application/pdf",
    "content-length": pdf.length,
    "content-disposition": `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    "cache-control": "no-store",
  });
  res.end(pdf);
}

const SelectionBody = z.object({
  photos: z.array(z.object({ file: z.string().max(200), room: z.string().max(200).optional(), selected: z.boolean().optional() })).max(200),
});
const RunBody = z.object({ tiers: z.array(z.enum(TIERS)).min(1), profile: z.string().max(60) });
const CreateProfileBody = z.object({ name: z.string().max(60), description: z.string().max(300).optional(), from: z.string().max(60).nullable().optional() });

async function handle(req: IncomingMessage, res: ServerResponse) {
  // Refuse public hostnames so a DNS-rebinding page can't reach this server.
  // Private IPv4 addresses are allowed for access from another device on the LAN.
  if (!isAllowedRequestHost(req.headers.host ?? "")) return send(res, 421, { error: "Unexpected host" });
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const parts = url.pathname.split("/").filter(Boolean);

  // Writes must come from this page, not from another site in the same browser.
  if (req.method !== "GET" && req.method !== "HEAD") {
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}`) return send(res, 403, { error: "Cross-origin request refused" });
  }

  if (parts[0] === "api") {
    if (req.method === "GET" && parts[1] === "listings" && parts.length === 2) {
      const listings = await listListings();
      return send(res, 200, listings.map((l) => ({
        id: l.id,
        name: l.name,
        photoCount: l.photos.length,
        selectedCount: l.photos.filter((p) => p.selected).length,
        cover: l.photos[0] ? `/thumb/listings/${l.id}/${encodeURIComponent(l.photos[0].file)}?w=160` : null,
      })));
    }
    if (req.method === "POST" && parts[1] === "listings" && parts.length === 2) {
      const body = z.object({ name: z.string().max(80), location: z.string().max(120).nullable().optional(), description: z.string().max(300).optional() }).parse(await readBody(req));
      const listing = await createListing(body);
      return send(res, 201, { id: listing.id });
    }
    if (req.method === "PUT" && parts[1] === "listings" && parts[2] === "order" && parts.length === 3) {
      const body = z.object({ ids: z.array(z.string().max(200)).max(1000) }).parse(await readBody(req));
      await saveListingOrder(body.ids);
      return send(res, 200, { saved: true });
    }
    if (parts[1] === "listings" && parts[2]) {
      const dir = listingDir(parts[2]);
      if (!existsSync(dir)) return send(res, 404, { error: "Listing not found" });
      if (req.method === "POST" && parts[3] === "restore" && parts.length === 4) {
        if (isRunning("redesign", parts[2])) return send(res, 409, { error: "Wait for the running redesign to finish." });
        await restoreListing(parts[2]);
        return send(res, 200, listingJson(await readListing(dir), await listRuns(parts[2])));
      }
      if ((await readListing(dir)).deletedAt) return send(res, 404, { error: "Listing not found" });
      if (req.method === "POST" && parts[3] === "duplicate" && parts.length === 4) {
        if (isRunning("redesign", parts[2])) return send(res, 409, { error: "Wait for the running redesign to finish before duplicating this listing." });
        const copy = await duplicateListing(parts[2]);
        return send(res, 201, { id: copy.id });
      }
      if (req.method === "DELETE" && parts.length === 3) {
        if (isRunning("redesign", parts[2])) return send(res, 409, { error: "Wait for the running redesign to finish before deleting this listing." });
        await deleteListing(parts[2]);
        return send(res, 200, { deleted: true });
      }
      if (req.method === "GET" && parts.length === 3) return send(res, 200, listingJson(await readListing(dir), await listRuns(parts[2])));
      if (req.method === "PATCH" && parts.length === 3) {
        const body = z.object({ name: z.string().max(80), location: z.string().max(120).nullable().optional(), description: z.string().max(300).optional() }).parse(await readBody(req));
        await updateListingDetails(dir, body);
        return send(res, 200, listingJson(await readListing(dir), await listRuns(parts[2])));
      }
      if (req.method === "POST" && parts[3] === "photos") {
        if (isRunning("redesign", parts[2])) return send(res, 409, { error: "Wait for the running redesign to finish before adding photos." });
        const file = await addListingPhoto(dir, await readRaw(req, 40_000_000));
        return send(res, 201, { file });
      }
      if (req.method === "PUT" && parts[3] === "selection") {
        const body = SelectionBody.parse(await readBody(req));
        return send(res, 200, listingJson(await saveSelection(dir, body.photos), await listRuns(parts[2])));
      }
      if (req.method === "POST" && parts[3] === "runs") {
        const body = RunBody.parse(await readBody(req));
        if (isRunning("redesign", parts[2])) return send(res, 409, { error: "This listing already has a redesign running. Wait for it to finish." });
        if (!(await listProfiles()).some((p) => p.id === body.profile)) return send(res, 400, { error: "Unknown taste profile." });
        try {
          requireKeys(resolveModels());
        } catch (error) {
          return send(res, 400, { error: (error as Error).message });
        }
        const listing = await readListing(dir);
        if (!listing.photos.some((p) => p.selected)) return send(res, 400, { error: "Select at least one photo." });

        const job = startJob("redesign", listing.id, () =>
          runListingRedesign({ listingDir: dir, profilePath: profileJsonPath(body.profile), tiers: body.tiers }),
        );
        return send(res, 202, jobView(job));
      }
    }
    if (req.method === "POST" && parts[1] === "jobs" && parts[2] && parts[3] === "cancel") {
      const job = jobs.get(parts[2]);
      if (!job) return send(res, 404, { error: "Job not found" });
      if (job.status === "running") {
        job.progress.cancelled = true;
        job.progress.label = "Stopping after the current step…";
      }
      return send(res, 200, jobView(job));
    }
    if (req.method === "GET" && parts[1] === "jobs" && parts[2]) {
      const job = jobs.get(parts[2]);
      return job ? send(res, 200, jobView(job)) : send(res, 404, { error: "Job not found" });
    }
    if (req.method === "GET" && parts[1] === "profiles") {
      const profiles = await listProfiles();
      return send(res, 200, await Promise.all(profiles.map(async (profile) => {
        const stored = await readTasteProfile(profile.id);
        return {
          ...profile,
          description: stored?.meta.description ?? "",
          referenceCount: stored?.references.length ?? 0,
          previews: (stored?.references ?? []).slice(0, 3).map((file) =>
            `/thumb/profiles/${encodeURIComponent(profile.id)}/references/${encodeURIComponent(file)}?w=480`),
        };
      })));
    }

    if (parts[1] === "taste-profiles") {
      if (req.method === "PUT" && parts[2] === "order" && parts.length === 3) {
        const body = z.object({ ids: z.array(z.string().max(200)).max(1000) }).parse(await readBody(req));
        await saveTasteProfileOrder(body.ids);
        return send(res, 200, { saved: true });
      }
      if (parts.length === 2) {
        if (req.method === "GET") {
          const list = await listTasteProfiles();
          return send(res, 200, list.map((p) => ({ ...p, running: isRunning("taste", p.id) })));
        }
        if (req.method === "POST") {
          const body = CreateProfileBody.parse(await readBody(req));
          const id = await createTasteProfile(body.name, body.from ?? null, body.description ?? "");
          return send(res, 201, await tasteProfileJson(id));
        }
      }
      const id = parts[2]!;
      if (!existsSync(path.join(profileDir(id), "meta.json"))) return send(res, 404, { error: "Profile not found" });
      const busy = () => isRunning("taste", id) && send(res, 409, { error: "This profile is rebuilding. Wait for it to finish." });

      if (req.method === "POST" && parts[3] === "restore" && parts.length === 4) {
        if (busy()) return;
        await restoreTasteProfile(id);
        return send(res, 200, await tasteProfileJson(id));
      }
      const currentTaste = await readTasteProfile(id);
      if (!currentTaste) return send(res, 404, { error: "Profile not found" });
      if (req.method === "POST" && parts[3] === "duplicate" && parts.length === 4) {
        if (busy()) return;
        const copyId = await createTasteProfile(`Copy of ${currentTaste.meta.name}`, id, currentTaste.meta.description);
        return send(res, 201, { id: copyId });
      }
      if (req.method === "DELETE" && parts.length === 3) {
        if (busy()) return;
        await deleteTasteProfile(id);
        return send(res, 200, { deleted: true });
      }

      if (req.method === "GET" && parts.length === 3) return send(res, 200, await tasteProfileJson(id));
      if (req.method === "PATCH" && parts.length === 3) {
        const body = z.object({ name: z.string().max(60), description: z.string().max(300).optional() }).parse(await readBody(req));
        await renameTasteProfile(id, body.name, body.description);
        return send(res, 200, await tasteProfileJson(id));
      }
      if (req.method === "PUT" && parts[3] === "brief") {
        if (busy()) return;
        await saveBrief(id, z.object({ text: z.string().max(50_000) }).parse(await readBody(req)).text);
        return send(res, 200, await tasteProfileJson(id));
      }
      if (req.method === "PUT" && parts[3] === "rules") {
        if (busy()) return;
        const profile = TasteProfile.parse((await readBody(req)) as object);
        const current = await readTasteProfile(id);
        await saveProfileJson(id, { ...profile, imageCount: current?.profile?.imageCount ?? current?.references.length ?? 0 }, "manual");
        return send(res, 200, await tasteProfileJson(id));
      }
      if (req.method === "POST" && parts[3] === "restore-previous") {
        if (busy()) return;
        if (!(await restorePreviousProfile(id))) return send(res, 404, { error: "No previous version to restore." });
        return send(res, 200, await tasteProfileJson(id));
      }
      if (parts[3] === "references") {
        if (busy()) return;
        if (req.method === "POST" && parts.length === 4) {
          const file = await addReference(id, await readRaw(req, 30_000_000));
          return send(res, 201, { file, profile: await tasteProfileJson(id) });
        }
        if (req.method === "DELETE" && parts[4]) {
          await removeReference(id, decodeURIComponent(parts[4]));
          return send(res, 200, await tasteProfileJson(id));
        }
        if (req.method === "POST" && parts[4] && parts[5] === "restore") {
          await restoreReference(id, decodeURIComponent(parts[4]));
          return send(res, 200, await tasteProfileJson(id));
        }
      }
      if (req.method === "POST" && parts[3] === "build") {
        if (busy()) return;
        try {
          requireKeys(resolveModels());
        } catch (error) {
          return send(res, 400, { error: (error as Error).message });
        }
        const job = startJob("taste", id, () => runTasteBuild(id));
        return send(res, 202, jobView(job));
      }
    }
    if (req.method === "GET" && parts[1] === "status") {
      let keysError: string | null = null;
      try {
        requireKeys(resolveModels());
      } catch (error) {
        keysError = (error as Error).message;
      }
      return send(res, 200, { keysError });
    }
    return send(res, 404, { error: "Not found" });
  }

  if (req.method === "GET" && parts[0] === "files" && parts[1] === "listings") return sendFile(res, safeJoin(LISTINGS_DIR, parts.slice(2).join("/")));
  // Only reference photos are served from profiles/, never briefs or rules files.
  if (req.method === "GET" && (parts[0] === "files" || parts[0] === "thumb") && parts[1] === "profiles" && parts[3] === "references" && parts.length === 5) {
    const file = safeJoin(PROFILES_DIR, parts.slice(2).join("/"));
    if (parts[0] === "files") return sendFile(res, file);
    return sendThumb(res, file, Math.min(1600, Math.max(80, Number(url.searchParams.get("w")) || 480)));
  }
  if (req.method === "GET" && parts[0] === "files" && parts[1] === "runs") {
    const file = safeJoin(RUNS_DIR, parts.slice(2).join("/"));
    if (file && path.basename(file) === "report.html") {
      const fresh = await freshReport(path.dirname(file));
      if (fresh) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
        return res.end(fresh);
      }
    }
    return sendFile(res, file);
  }
  if (req.method === "GET" && parts[0] === "pdf" && parts[1] === "runs" && parts.length === 4) {
    return sendReportPdf(res, safeJoin(RUNS_DIR, parts.slice(2).join("/")), url.searchParams.get("detail"));
  }
  if (req.method === "GET" && parts[0] === "thumb" && parts[1] === "listings") {
    const width = Math.min(1600, Math.max(80, Number(url.searchParams.get("w")) || 640));
    return sendThumb(res, safeJoin(LISTINGS_DIR, parts.slice(2).join("/")), width);
  }
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
    return res.end(await readFile(INDEX));
  }
  send(res, 405, { error: "Method not allowed" });
}

loadEnv();
createServer((req, res) => {
  handle(req, res).catch((error) => {
    const status = error instanceof z.ZodError || error instanceof SyntaxError ? 400 : ((error as { status?: number }).status ?? 500);
    send(res, status, { error: error instanceof z.ZodError ? "Invalid request" : (error as Error).message });
  });
}).listen(PORT, HOST, () => {
  process.stderr.write(`[remodel-lens] Listing picker at http://localhost:${PORT}\n`);
});
