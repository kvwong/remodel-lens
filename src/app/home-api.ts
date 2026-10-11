// Home screen data: the newest reports and a reel of redesigned photos from them.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { listListings } from "../listing/listing.js";
import { listRuns, RUNS_DIR, type RunSummary } from "../redesign/job.js";
import type { PhotoResult } from "../redesign/run.js";
import { TIER_LABELS } from "../redesign/tiers.js";

const RECENT_REPORTS = 5;
const MAX_SLIDES = 24;
const ROW_IMAGES = 4;
const SLIDE_STATUSES = new Set(["verified", "review"]);

const urlPath = (...segments: string[]) => segments.map(encodeURIComponent).join("/");

type ReportRun = RunSummary & { reportUrl: string; listingId: string; listingName: string };
export type HomeSlide = { src: string; alt: string; caption: string; reportUrl: string };
export type HomeReport = ReportRun & { images: HomeSlide[] };

export async function homeView(allReports = false): Promise<{ reports: HomeReport[]; totalReports: number; slides: HomeSlide[] }> {
  const listings = await listListings();
  const runs = (await Promise.all(listings.map(async (listing) =>
    (await listRuns(listing.id)).filter((run) => run.report).map((run) => ({
      ...run,
      reportUrl: `/files/runs/${urlPath(listing.id, run.id, run.report!)}`,
      listingId: listing.id,
      listingName: listing.name,
    })),
  ))).flat().sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.listingName.localeCompare(b.listingName));

  // Preserve newest-first report order, with one representative image per scope.
  const recent = allReports ? runs : runs.slice(0, RECENT_REPORTS);
  const slides = allReports ? [] : (await Promise.all(runs.slice(0, MAX_SLIDES).map((run) => runSlides(run, 720, true)))).flat().slice(0, MAX_SLIDES);
  const reports = await Promise.all(recent.map(async (run) => ({
    ...run,
    images: (await runSlides(run, 240)).slice(0, ROW_IMAGES),
  })));
  return { reports, totalReports: runs.length, slides };
}

/** Redesigned images worth showing off from one run: ones that passed or only need a second look. */
async function runSlides(run: ReportRun, width = 720, representative = false): Promise<HomeSlide[]> {
  const resultsPath = path.join(RUNS_DIR, run.listingId, run.id, "results.json");
  if (!existsSync(resultsPath)) return [];
  let photos: PhotoResult[];
  try {
    photos = JSON.parse(await readFile(resultsPath, "utf8")) as PhotoResult[];
  } catch {
    return [];
  }
  if (representative) {
    const scopes = [...new Set(photos.flatMap((photo) => photo.tiers.map((t) => t.tier)))];
    return scopes.flatMap((scope) => {
      const candidates = photos.flatMap((photo) => photo.tiers
        .filter((t) => t.tier === scope && t.image && SLIDE_STATUSES.has(t.status))
        .map((result) => ({ photo, result })));
      const roomPriority = (photo: PhotoResult) => /kitchen|living|great room|family|dining/i.test(photo.room || photo.inventory?.roomType || "") ? 1 : 0;
      candidates.sort((a, b) => Number(b.result.status === "verified") - Number(a.result.status === "verified") || roomPriority(b.photo) - roomPriority(a.photo));
      const chosen = candidates[0];
      if (!chosen) return [];
      const room = chosen.photo.room || chosen.photo.inventory?.roomType || "Room";
      const tier = TIER_LABELS[scope]?.name ?? scope;
      return [{
        src: `/thumb/runs/${urlPath(run.listingId, run.id, ...chosen.result.image!.split("/"))}?w=${width}`,
        alt: `${tier} redesign of the ${room.toLowerCase()} at ${run.listingName}`,
        caption: `${run.listingName} · ${sentence(room)} · ${tier}`,
        reportUrl: `${run.reportUrl}?scope=${encodeURIComponent(scope)}`,
      }];
    });
  }
  // One image per photo first, so a run's reel shows different rooms before a second tier of the same one.
  const byPhoto = photos.map((photo) =>
    photo.tiers.filter((t) => t.image && SLIDE_STATUSES.has(t.status)).reverse().map((t) => {
      const room = photo.room || photo.inventory?.roomType || "Room";
      const tier = TIER_LABELS[t.tier]?.name ?? t.tier;
      return {
        src: `/thumb/runs/${urlPath(run.listingId, run.id, ...t.image!.split("/"))}?w=${width}`,
        alt: `${tier} redesign of the ${room.toLowerCase()} at ${run.listingName}`,
        caption: `${run.listingName} · ${sentence(room)} · ${tier}`,
        reportUrl: run.reportUrl,
      };
    }),
  );
  const slides: HomeSlide[] = [];
  for (let round = 0; byPhoto.some((list) => list[round]); round++) {
    for (const list of byPhoto) if (list[round]) slides.push(list[round]!);
  }
  return slides;
}

const sentence = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
