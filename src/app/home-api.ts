// Home screen data: the newest reports and a reel of redesigned photos from them.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { listListings } from "../listing/listing.js";
import { listRuns, RUNS_DIR, type RunSummary } from "../redesign/job.js";
import type { PhotoResult } from "../redesign/run.js";
import { TIER_LABELS } from "../redesign/tiers.js";

const RECENT_REPORTS = 5;
const MAX_SLIDES = 18;
const SLIDES_PER_RUN = 6;
const SLIDE_STATUSES = new Set(["verified", "review"]);

const urlPath = (...segments: string[]) => segments.map(encodeURIComponent).join("/");

export type HomeReport = RunSummary & { reportUrl: string; listingId: string; listingName: string };
export type HomeSlide = { src: string; alt: string; caption: string; reportUrl: string };

export async function homeView(): Promise<{ reports: HomeReport[]; totalReports: number; slides: HomeSlide[] }> {
  const listings = await listListings();
  const runs = (await Promise.all(listings.map(async (listing) =>
    (await listRuns(listing.id)).filter((run) => run.report).map((run) => ({
      ...run,
      reportUrl: `/files/runs/${urlPath(listing.id, run.id, run.report!)}`,
      listingId: listing.id,
      listingName: listing.name,
    })),
  ))).flat().sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.listingName.localeCompare(b.listingName));

  const slides: HomeSlide[] = [];
  for (const run of runs) {
    if (slides.length >= MAX_SLIDES) break;
    slides.push(...(await runSlides(run)).slice(0, Math.min(SLIDES_PER_RUN, MAX_SLIDES - slides.length)));
  }
  return { reports: runs.slice(0, RECENT_REPORTS), totalReports: runs.length, slides };
}

/** Redesigned images worth showing off from one run: ones that passed or only need a second look. */
async function runSlides(run: HomeReport): Promise<HomeSlide[]> {
  const resultsPath = path.join(RUNS_DIR, run.listingId, run.id, "results.json");
  if (!existsSync(resultsPath)) return [];
  let photos: PhotoResult[];
  try {
    photos = JSON.parse(await readFile(resultsPath, "utf8")) as PhotoResult[];
  } catch {
    return [];
  }
  // One image per photo first, so a run's reel shows different rooms before a second tier of the same one.
  const byPhoto = photos.map((photo) =>
    photo.tiers.filter((t) => t.image && SLIDE_STATUSES.has(t.status)).reverse().map((t) => {
      const room = photo.room || photo.inventory?.roomType || "Room";
      const tier = TIER_LABELS[t.tier]?.name ?? t.tier;
      return {
        src: `/thumb/runs/${urlPath(run.listingId, run.id, ...t.image!.split("/"))}?w=720`,
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
