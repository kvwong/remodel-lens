import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { requireKeys, resolveModels, ROOT } from "../config.js";
import { spentOnRun } from "../costs.js";
import { loadImages, log, progressContext, runId, writeArtifact, writeJson } from "../files.js";
import { readListing } from "../listing/listing.js";
import { renderReport } from "../report.js";
import { TasteProfile } from "../taste/schema.js";
import { listTasteProfiles, profileJsonPath } from "../taste/store.js";
import { redesignListing, type PhotoResult } from "./run.js";
import type { Tier } from "./tiers.js";

export const RUNS_DIR = path.join(ROOT, ".runs", "redesign");

export type RunSummary = {
  id: string;
  listing: string;
  profile: string;
  tiers: Tier[];
  photos: string[];
  startedAt: string;
  finishedAt: string | null;
  counts: Record<string, number>;
  report: string | null; // path relative to the run dir
  error: string | null;
  /** Estimated API spend for the run, in USD. */
  apiCost?: number;
  /** True when the run was stopped before every photo finished. */
  stopped?: boolean;
  /** Image edit model used for the run. Missing on runs from before it was recorded. */
  imageModel?: string;
  /** Filled in by listRuns from the profile's metadata. */
  profileName?: string | null;
};

/** Paths from before profiles became folders, as recorded in older run.json files. */
const LEGACY_PROFILE_PATHS: Record<string, string> = {
  "profiles/seed-taste-profile.json": "profiles/seed/profile.json",
};

export async function loadProfile(profilePath: string): Promise<TasteProfile> {
  const relative = path.relative(ROOT, path.resolve(ROOT, profilePath));
  const resolved = path.resolve(ROOT, LEGACY_PROFILE_PATHS[relative] ?? relative);
  const raw = JSON.parse(await readFile(resolved, "utf8"));
  return { ...TasteProfile.parse(raw), imageCount: raw.imageCount } as TasteProfile;
}

/** Profiles that have rules and can drive a redesign. */
export async function listProfiles(): Promise<Array<{ id: string; name: string; path: string; stale: boolean }>> {
  return (await listTasteProfiles())
    .filter((p) => p.built)
    .map((p) => ({ id: p.id, name: p.name, path: profileJsonPath(p.id), stale: p.stale }));
}

export async function runListingRedesign(input: {
  listingDir: string;
  profilePath: string;
  tiers: Tier[];
  outDir?: string | undefined;
  max?: number | undefined;
  /** Overrides IMAGE_MODEL for this run, e.g. to compare image models on the same listing. */
  imageModel?: string | undefined;
}): Promise<RunSummary & { outDir: string }> {
  const models = { ...resolveModels(), ...(input.imageModel ? { image: input.imageModel } : {}) };
  requireKeys(models);
  const profile = await loadProfile(input.profilePath);
  const listing = await readListing(input.listingDir);
  const selected = listing.photos.filter((p) => p.selected);
  if (selected.length === 0) throw new Error(`No photos selected in ${listing.name}.`);

  const rooms = new Map(selected.map((p) => [p.file, p.room]));
  const photos = (await loadImages(listing.dir, input.max ?? 24, "photo", new Set(rooms.keys()))).map((photo) => ({
    ...photo,
    roomHint: rooms.get(photo.basename) || undefined,
  }));

  const outDir = input.outDir ?? path.join(RUNS_DIR, listing.id, runId());
  const id = path.basename(outDir); // the folder name is what report URLs resolve against
  const summary: RunSummary = {
    id,
    listing: listing.id,
    profile: path.relative(ROOT, path.resolve(ROOT, input.profilePath)),
    tiers: input.tiers,
    imageModel: models.image,
    photos: photos.map((p) => p.basename),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    counts: {},
    report: null,
    error: null,
  };
  await writeJson(outDir, "run.json", summary);
  log(`${listing.name}: ${photos.length} photos × ${input.tiers.join("/")} → ${path.relative(ROOT, outDir)}`);

  let results: PhotoResult[];
  try {
    results = await redesignListing({ photos, profile, tiers: input.tiers, models, outDir, location: listing.location });
  } catch (error) {
    summary.error = error instanceof Error ? error.message : String(error);
    summary.finishedAt = new Date().toISOString();
    await writeJson(outDir, "run.json", summary);
    throw error;
  }

  await writeJson(outDir, "results.json", results);
  await writeArtifact(outDir, "report.html", renderReport({ title: listing.name, photos: results, profileSummary: profile.summary, location: listing.location, run: { startedAt: summary.startedAt, profileName: null } }));
  summary.counts = results.flatMap((r) => r.tiers).reduce<Record<string, number>>((acc, t) => ({ ...acc, [t.status]: (acc[t.status] ?? 0) + 1 }), {});
  summary.apiCost = Math.round(spentOnRun(results) * 100) / 100;
  summary.stopped = !!progressContext.getStore()?.cancelled;
  if (summary.stopped) log(`Stopped early: ${results.length} of ${photos.length} photos finished`);
  summary.report = "report.html";
  summary.finishedAt = new Date().toISOString();
  await writeJson(outDir, "run.json", summary);
  log(`Done: ${Object.entries(summary.counts).map(([k, v]) => `${v} ${k}`).join(", ")}`);
  return { ...summary, outDir };
}

export async function listRuns(listingId: string): Promise<RunSummary[]> {
  const dir = path.join(RUNS_DIR, listingId);
  if (!existsSync(dir)) return [];
  const runs = await Promise.all(
    (await readdir(dir)).map(async (run) => {
      const file = path.join(dir, run, "run.json");
      // Trust the folder name over the stored id, so renamed or custom-named run folders still link correctly.
      return existsSync(file) ? ({ ...(JSON.parse(await readFile(file, "utf8")) as RunSummary), id: run }) : null;
    }),
  );
  const names = new Map((await listTasteProfiles()).map((p) => [profileJsonPath(p.id), p.name]));
  return runs
    .filter((r): r is RunSummary => r !== null)
    .map((r) => ({ ...r, profileName: names.get(LEGACY_PROFILE_PATHS[r.profile] ?? r.profile) ?? null }))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
