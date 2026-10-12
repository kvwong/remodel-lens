// Sort a listing's photos before a run: keep interior rooms, skip exteriors, floor plans and anything else.
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";

import { log, mapLimit } from "../files.js";
import { generateStructured, type ImageInput } from "../providers.js";
import { readListing, saveSelection, type Listing } from "./listing.js";

export const PHOTO_KINDS = ["interior", "exterior", "floor_plan", "other"] as const;

const PhotoSort = z.object({
  photos: z.array(z.object({
    id: z.string().describe("The photo's label, e.g. photo_3"),
    kind: z.enum(PHOTO_KINDS).describe("interior: a room inside the home. exterior: outside the house, yard, street, view, pool, deck or balcony. floor_plan: a floor plan, site plan or other drawing. other: maps, aerials, amenities, signs, close-ups of a single object."),
    room: z.string().describe("For interiors, the room in a few lowercase words (kitchen, living room, primary bathroom). Empty otherwise."),
  })),
});
export type PhotoSort = z.infer<typeof PhotoSort>;

/** Photos per call: enough to see the whole listing at once, small enough to stay quick. */
const BATCH = 20;
const THUMB_WIDTH = 512;

const prompt = (ids: string[]) => `These are real-estate listing photos, labeled in order: ${ids.join(", ")}.
Sort each one so only interior rooms get redesigned. Return one entry per photo, using its label as id.
- interior: a room inside the home (kitchen, living, bedroom, bathroom, hall, laundry, finished basement, garage interior).
- exterior: the outside of the house, yard, street, view, pool, deck, patio or balcony.
- floor_plan: floor plans, site plans and any other drawings.
- other: maps, aerial shots, community amenities, signs, and close-ups that don't show a room.`;

type Generate = typeof generateStructured;

/**
 * Looks at small copies of every photo, keeps interiors selected and labels their rooms (without overwriting a room
 * someone typed), and skips the rest. Throws when nothing is left to redesign.
 */
export async function keepInteriorPhotos(dir: string, model: string, generate: Generate = generateStructured): Promise<{ listing: Listing; kept: number; skipped: number }> {
  const listing = await readListing(dir);
  log(`Sorting ${listing.photos.length} photo${listing.photos.length === 1 ? "" : "s"}: interiors only`);
  const thumbs = await mapLimit(listing.photos, 6, async (photo): Promise<ImageInput> => ({
    bytes: await sharp(path.join(dir, photo.file)).rotate().resize({ width: THUMB_WIDTH, withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer(),
    mediaType: "image/jpeg",
  }));

  const batches = Array.from({ length: Math.ceil(thumbs.length / BATCH) }, (_, b) => b * BATCH);
  const kinds = new Map<string, { kind: (typeof PHOTO_KINDS)[number]; room: string }>();
  await Promise.all(batches.map(async (start) => {
    const ids = thumbs.slice(start, start + BATCH).map((_, i) => `photo_${start + i + 1}`);
    const result = await generate({ model, prompt: prompt(ids), schema: PhotoSort, images: thumbs.slice(start, start + BATCH), maxOutputTokens: 4000 });
    for (const entry of result.photos) kinds.set(entry.id.trim().toLowerCase(), entry);
  }));

  // A photo the model didn't mention stays selected, so a short answer never silently drops a room.
  const updates = listing.photos.map((photo, i) => {
    const sorted = kinds.get(`photo_${i + 1}`);
    const keep = !sorted || sorted.kind === "interior";
    return { file: photo.file, selected: keep, room: photo.room || (keep ? sorted?.room.trim() ?? "" : "") };
  });
  const kept = updates.filter((u) => u.selected).length;
  if (!kept) throw new Error("No interior photos found in this listing, so there's nothing to redesign.");
  const saved = await saveSelection(dir, updates);
  log(`Kept ${kept} interior photo${kept === 1 ? "" : "s"}, skipped ${updates.length - kept} (exteriors, floor plans and other shots)`);
  return { listing: saved, kept, skipped: updates.length - kept };
}
