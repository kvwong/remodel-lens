import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";

import { ROOT } from "../config.js";
import { IMAGE_EXTENSIONS, imageFingerprint, isNearDuplicate } from "../files.js";

export const LISTINGS_DIR = path.join(ROOT, "listings");

const ListingFile = z.object({
  name: z.string().optional(),
  source: z.string().optional(),
  location: z.string().optional(),
  description: z.string().optional(),
  photos: z.record(z.string(), z.object({ room: z.string().default(""), selected: z.boolean().default(true) })).default({}),
});

export type ListingPhoto = { file: string; room: string; selected: boolean };
export type Listing = { id: string; name: string; source: string | null; location: string | null; description: string; dir: string; photos: ListingPhoto[] };

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

export function listingDir(id: string): string {
  if (!ID_PATTERN.test(id)) throw new Error(`Invalid listing id "${id}".`);
  return path.join(LISTINGS_DIR, id);
}

export async function listListings(): Promise<Listing[]> {
  if (!existsSync(LISTINGS_DIR)) return [];
  const entries = await readdir(LISTINGS_DIR, { withFileTypes: true });
  const listings = await Promise.all(
    entries.filter((e) => e.isDirectory() && ID_PATTERN.test(e.name)).map((e) => readListing(path.join(LISTINGS_DIR, e.name))),
  );
  // A listing exists once it has metadata or photos, so newly created empty listings still show up.
  return listings
    .filter((l) => l.photos.length > 0 || existsSync(path.join(l.dir, "listing.json")))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Folder contents are the source of truth for which photos exist; listing.json only adds labels and selection. */
export async function readListing(dir: string): Promise<Listing> {
  const id = path.basename(dir);
  const metaPath = path.join(dir, "listing.json");
  const meta = ListingFile.parse(existsSync(metaPath) ? JSON.parse(await readFile(metaPath, "utf8")) : {});
  const files = (await readdir(dir))
    .filter((f) => IMAGE_EXTENSIONS.has(path.extname(f).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return {
    id,
    name: meta.name ?? id,
    source: meta.source ?? null,
    location: meta.location ?? null,
    description: meta.description ?? "",
    dir,
    photos: files.map((file) => ({ file, room: meta.photos[file]?.room ?? "", selected: meta.photos[file]?.selected ?? true })),
  };
}

export async function saveSelection(dir: string, photos: Array<{ file: string; room?: string; selected?: boolean }>): Promise<Listing> {
  const listing = await readListing(dir);
  const updates = new Map(photos.map((p) => [p.file, p]));
  const metaPath = path.join(dir, "listing.json");
  const existing = existsSync(metaPath) ? JSON.parse(await readFile(metaPath, "utf8")) : {};
  const next = {
    ...existing,
    name: listing.name,
    photos: Object.fromEntries(
      listing.photos.map((photo) => {
        const update = updates.get(photo.file);
        return [
          photo.file,
          {
            room: (update?.room ?? photo.room).trim().slice(0, 80),
            selected: update?.selected ?? photo.selected,
          },
        ];
      }),
    ),
  };
  await writeFile(metaPath, `${JSON.stringify(next, null, 2)}\n`);
  return readListing(dir);
}

const MAX_PHOTO_EDGE = 2560;
export const MAX_LISTING_PHOTOS = 40;

function slug(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "listing";
}

export async function createListing(input: { name: string; location?: string | null; description?: string }): Promise<Listing> {
  const name = input.name.trim().slice(0, 80);
  if (!name) throw Object.assign(new Error("Give the listing a name."), { status: 400 });
  let id = slug(name);
  for (let n = 2; existsSync(path.join(LISTINGS_DIR, id)); n += 1) id = `${slug(name).slice(0, 36)}-${n}`;
  const dir = path.join(LISTINGS_DIR, id);
  await mkdir(dir, { recursive: true });
  const location = input.location?.trim().slice(0, 120) || undefined;
  const description = input.description?.trim().slice(0, 300) || undefined;
  await writeFile(path.join(dir, "listing.json"), `${JSON.stringify({ name, ...(location ? { location } : {}), ...(description ? { description } : {}), photos: {} }, null, 2)}\n`);
  return readListing(dir);
}


/** Normalize an uploaded listing photo (EXIF rotation, size cap, JPEG), refuse near-duplicates, continue numbering. */
export async function addListingPhoto(dir: string, bytes: Buffer): Promise<string> {
  const listing = await readListing(dir);
  if (listing.photos.length >= MAX_LISTING_PHOTOS) {
    throw Object.assign(new Error(`A listing can hold up to ${MAX_LISTING_PHOTOS} photos.`), { status: 400 });
  }
  let format: string | undefined;
  try {
    format = (await sharp(bytes).metadata()).format;
  } catch {
    throw Object.assign(new Error("That file isn't an image this app can read. Use JPG, PNG, WebP, or TIFF."), { status: 415 });
  }
  if (format === "heif") throw Object.assign(new Error("HEIC photos aren't supported. Export as JPG first."), { status: 415 });

  const print = await imageFingerprint(bytes);
  for (const photo of listing.photos) {
    if (isNearDuplicate(await imageFingerprint(path.join(dir, photo.file)), print)) {
      throw Object.assign(new Error(`Already in this listing as ${photo.file}.`), { status: 409 });
    }
  }
  const next = Math.max(0, ...listing.photos.map((p) => Number(p.file.match(/-(\d+)\.\w+$/)?.[1] ?? 0))) + 1;
  const file = `${listing.id}-${String(next).padStart(2, "0")}.jpg`;
  await sharp(bytes)
    .rotate()
    .resize({ width: MAX_PHOTO_EDGE, height: MAX_PHOTO_EDGE, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#fff" })
    .jpeg({ quality: 90, mozjpeg: true })
    .toFile(path.join(dir, file));
  await saveSelection(dir, [{ file, room: "", selected: true }]);
  return file;
}

/** Edit display details; the folder id (and with it run history and URLs) stays the same. */
export async function updateListingDetails(dir: string, input: { name: string; location?: string | null; description?: string }): Promise<Listing> {
  const name = input.name.trim().slice(0, 80);
  if (!name) throw Object.assign(new Error("Give the listing a name."), { status: 400 });
  const metaPath = path.join(dir, "listing.json");
  const meta = existsSync(metaPath) ? JSON.parse(await readFile(metaPath, "utf8")) : { photos: {} };
  meta.name = name;
  const location = input.location?.trim().slice(0, 120);
  if (location) meta.location = location; else delete meta.location;
  const description = input.description?.trim().slice(0, 300);
  if (description) meta.description = description; else delete meta.description;
  await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  return readListing(dir);
}
