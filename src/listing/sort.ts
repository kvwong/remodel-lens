// Sort a listing's photos before a run: keep interior rooms, skip exteriors, floor plans and anything else.
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";

import { log, mapLimit } from "../files.js";
import { generateStructured, type ImageInput } from "../providers.js";
import { readListing, saveSelection, setAutomaticThumbnail, type Listing } from "./listing.js";

export const PHOTO_KINDS = ["interior", "exterior", "floor_plan", "other"] as const;
type Kind = (typeof PHOTO_KINDS)[number];
type Sorted = { kind: Kind; room: string; quality?: string; coverScore?: number };

const KIND_HELP: Record<Kind, string> = {
  interior: "A room inside the home: kitchen, living, bedroom, bathroom, hall, laundry, finished basement, garage interior.",
  exterior: "The outside of the house, yard, street, view, pool, deck, patio or balcony.",
  floor_plan: "A floor plan, site plan or any other drawing.",
  other: "Maps, aerial shots, community amenities, signs, and close-ups that don't show a room.",
};
const ROOMS = ["kitchen", "living room", "family room", "dining room", "bedroom", "primary bedroom", "bathroom", "primary bathroom", "office", "laundry room", "entry", "hallway", "basement", "garage", "other room"];

const THUMB_WIDTH = 512;

/**
 * OpenAI's Decisions API (gpt-6-luna, beta): one typed answer per photo, about 10x faster than a chat call and
 * $0.10 per million input tokens with no output charge.
 */
export const DECISIONS_MODEL = "gpt-6-luna";

type Fetch = typeof fetch;

export async function decidePhoto(image: ImageInput, fetchFn: Fetch = fetch): Promise<Sorted> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("Missing OPENAI_API_KEY.");
  const res = await fetchFn("https://api.openai.com/v1/decisions", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({
      model: DECISIONS_MODEL,
      input: [{ role: "user", content: [
        { type: "input_text", text: "A real-estate listing photo. Only interior rooms will be redesigned." },
        { type: "input_image", image_url: `data:${image.mediaType};base64,${Buffer.from(image.bytes).toString("base64")}` },
      ] }],
      questions: [
        { type: "choice", name: "kind", instructions: "What does this photo show?", choices: PHOTO_KINDS.map((value) => ({ value, description: KIND_HELP[value] })) },
        { type: "choice", name: "room", instructions: "If it shows a room inside the home, which room is it?", choices: ROOMS.map((value) => ({ value, description: value })) },
        { type: "choice", name: "quality", instructions: "Is this photo a useful source for a realistic remodel? Ignore MLS watermarks, ordinary wide-angle photography, dated decor, and virtual staging. Flag only a clear problem.", choices: [
          { value: "usable", description: "A clear room or exterior view with enough visible detail." },
          { value: "blurred", description: "Severe blur makes room surfaces and boundaries hard to inspect." },
          { value: "obstructed", description: "A large obstruction hides most of the room." },
          { value: "detail_only", description: "A close-up of an object or finish without useful room context." },
          { value: "distorted", description: "Severe stitching or perspective distortion makes room geometry unreliable." },
        ] },
        { type: "score", name: "cover", instructions: "Rate suitability as a small listing thumbnail. Prefer a clear wide view of a living area, kitchen, or the house exterior. Avoid views, plans, close-ups, dark or obstructed images. Judge composition and recognizable house/room content, not expensive finishes.", levels: [
          { label: "poor", description: "Unclear, unusable, drawing, detail, or view without house/room context." },
          { label: "fair", description: "Recognizable but limited context, cluttered composition, or a secondary room." },
          { label: "good", description: "Clear, well framed, recognizable view of a main room or house." },
          { label: "excellent", description: "Especially clear, balanced wide view of a main living area, kitchen, or house, legible at thumbnail size." },
        ] },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Decisions API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { answers?: Array<{ type: string; name: string; choice?: string; confidence?: number; score?: number }> };
  const answer = (name: string) => body.answers?.find((a) => a.name === name && a.type === "choice")?.choice;
  const kind = answer("kind");
  if (!kind || !(PHOTO_KINDS as readonly string[]).includes(kind)) throw new Error("Decisions API gave no photo kind.");
  const room = answer("room");
  const quality = body.answers?.find(a => a.name === "quality" && a.type === "choice");
  const cover = body.answers?.find(a => a.name === "cover" && a.type === "score");
  const warnings: Record<string, string> = { blurred: "Severe blur", obstructed: "Room mostly obstructed", detail_only: "Detail photo: limited room context", distorted: "Severe image distortion" };
  return { kind: kind as Kind, room: kind === "interior" && room && room !== "other room" ? room : "",
    quality: quality && (quality.confidence ?? 0) >= 0.85 ? warnings[quality.choice ?? ""] ?? "" : "",
    ...(cover && Number.isFinite(cover.score) ? { coverScore: cover.score } : {}),
  };
}

export const PhotoSort = z.object({
  photos: z.array(z.object({
    id: z.string().describe("The photo's label, e.g. photo_3"),
    kind: z.enum(PHOTO_KINDS),
    room: z.string().describe("For interiors, the room in a few lowercase words (kitchen, living room, primary bathroom). Empty otherwise."),
  })),
});

/** The fallback when the Decisions API isn't available: the reasoning model looks at up to 20 photos per call. */
async function sortWithModel(thumbs: ImageInput[], model: string, generate: typeof generateStructured): Promise<Array<Sorted | undefined>> {
  const BATCH = 20;
  const out: Array<Sorted | undefined> = [];
  await Promise.all(Array.from({ length: Math.ceil(thumbs.length / BATCH) }, (_, b) => b * BATCH).map(async (start) => {
    const ids = thumbs.slice(start, start + BATCH).map((_, i) => `photo_${start + i + 1}`);
    const result = await generate({
      model, schema: PhotoSort, images: thumbs.slice(start, start + BATCH), maxOutputTokens: 4000,
      prompt: `These are real-estate listing photos, labeled in order: ${ids.join(", ")}.\nSort each one so only interior rooms get redesigned. Return one entry per photo, using its label as id.\n${PHOTO_KINDS.map((k) => `- ${k}: ${KIND_HELP[k]}`).join("\n")}`,
    });
    for (const entry of result.photos) {
      const n = Number(entry.id.trim().toLowerCase().replace(/^photo_/, ""));
      if (Number.isInteger(n) && n > start && n <= start + BATCH) out[n - 1] = { kind: entry.kind, room: entry.room.trim() };
    }
  }));
  return out;
}

/**
 * Looks at small copies of every photo, keeps interiors selected and labels their rooms (without overwriting a room
 * someone typed), and skips the rest. Throws when nothing is left to redesign.
 */
export async function keepInteriorPhotos(dir: string, model: string, deps: { fetch?: Fetch; generate?: typeof generateStructured; interiorsOnly?: boolean } = {}): Promise<{ listing: Listing; kept: number; skipped: number }> {
  const listing = await readListing(dir);
  log(`Sorting ${listing.photos.length} photo${listing.photos.length === 1 ? "" : "s"}: ${deps.interiorsOnly === false ? "quality and cover assessment" : "interiors only"}`);
  const thumbs = await mapLimit(listing.photos, 6, async (photo): Promise<ImageInput> => ({
    bytes: await sharp(path.join(dir, photo.file)).rotate().resize({ width: THUMB_WIDTH, withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer(),
    mediaType: "image/jpeg",
  }));

  let sorted: Array<Sorted | undefined>;
  try {
    sorted = await mapLimit(thumbs, 8, (thumb) => decidePhoto(thumb, deps.fetch));
  } catch (error) {
    log(`Decisions API unavailable (${error instanceof Error ? error.message : String(error)}); sorting with ${model}`);
    sorted = await sortWithModel(thumbs, model, deps.generate ?? generateStructured);
  }

  // A photo with no answer stays selected, so a short reply never silently drops a room.
  const updates = listing.photos.map((photo, i) => {
    const s = sorted[i];
    const keep = deps.interiorsOnly === false ? photo.selected : !s || s.kind === "interior";
    return { file: photo.file, selected: keep, room: photo.room || (keep ? s?.room ?? "" : ""), quality: s?.quality ?? photo.quality };
  });
  const kept = updates.filter((u) => u.selected).length;
  if (!kept && deps.interiorsOnly !== false) throw new Error("No interior photos found in this listing, so there's nothing to redesign.");
  let saved = await saveSelection(dir, updates);
  const cover = listing.photos.map((photo, i) => ({ file: photo.file, result: sorted[i] }))
    .filter(p => p.result && ["interior", "exterior"].includes(p.result.kind) && !p.result.quality && Number.isFinite(p.result.coverScore))
    .sort((a, b) => b.result!.coverScore! - a.result!.coverScore!)[0];
  if (cover && cover.result!.coverScore! >= 2) saved = await setAutomaticThumbnail(dir, cover.file);
  if (deps.interiorsOnly === false) log(`Assessed ${updates.length} photos; preserved photo selections`);
  else log(`Kept ${kept} interior photo${kept === 1 ? "" : "s"}, skipped ${updates.length - kept} (exteriors, floor plans and other shots)`);
  return { listing: saved, kept, skipped: updates.length - kept };
}

/** Assess imported or manually selected photos without changing the user's selection. */
export async function assessListingPhotos(dir: string, model: string): Promise<void> {
  await keepInteriorPhotos(dir, model, { interiorsOnly: false });
}
