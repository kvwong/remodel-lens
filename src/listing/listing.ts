import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { ROOT } from "../config.js";
import { IMAGE_EXTENSIONS } from "../files.js";

export const LISTINGS_DIR = path.join(ROOT, "listings");

const ListingFile = z.object({
  name: z.string().optional(),
  source: z.string().optional(),
  location: z.string().optional(),
  photos: z.record(z.string(), z.object({ room: z.string().default(""), selected: z.boolean().default(true) })).default({}),
});

export type ListingPhoto = { file: string; room: string; selected: boolean };
export type Listing = { id: string; name: string; source: string | null; location: string | null; dir: string; photos: ListingPhoto[] };

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
  return listings.filter((l) => l.photos.length > 0).sort((a, b) => a.name.localeCompare(b.name));
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
