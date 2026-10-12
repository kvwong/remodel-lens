import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";

import { ROOT } from "../config.js";
import { IMAGE_EXTENSIONS, imageFingerprint, isNearDuplicate, readSidebarOrder, saveSidebarOrder } from "../files.js";
import { addressFromUrl, downloadPhotos, scrapeListing, SITE_NAMES, type ScrapeResult } from "./scrape.js";

export const LISTINGS_DIR = path.join(ROOT, "listings");

const ListingFile = z.object({
  deletedAt: z.string().nullable().optional(),
  name: z.string().optional(),
  source: z.string().optional(),
  sourceUrl: z.string().optional(),
  location: z.string().optional(),
  description: z.string().optional(),
  thumbnail: z.string().optional(),
  photos: z.record(z.string(), z.object({ room: z.string().default(""), selected: z.boolean().default(true), quality: z.string().optional() })).default({}),
});

export type ListingPhoto = { file: string; room: string; selected: boolean; quality?: string };
export type Listing = { id: string; name: string; source: string | null; sourceUrl: string | null; location: string | null; description: string; thumbnail: string | null; deletedAt: string | null; dir: string; photos: ListingPhoto[] };

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

export function listingDir(id: string): string {
  if (!ID_PATTERN.test(id)) throw new Error(`Invalid listing id "${id}".`);
  return path.join(LISTINGS_DIR, id);
}

export async function listListings(dir = LISTINGS_DIR): Promise<Listing[]> {
  if (!existsSync(dir)) return [];
  const order = await readSidebarOrder(dir);
  const rank = new Map(order.map((id, index) => [id, index]));
  const entries = await readdir(dir, { withFileTypes: true });
  const listings = await Promise.all(
    entries.filter((e) => e.isDirectory() && ID_PATTERN.test(e.name)).map((e) => readListing(path.join(dir, e.name))),
  );
  // A listing exists once it has metadata or photos, so newly created empty listings still show up.
  return listings
    .filter((l) => !l.deletedAt && (l.photos.length > 0 || existsSync(path.join(l.dir, "listing.json"))))
    .sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity) || a.name.localeCompare(b.name));
}

export async function saveListingOrder(ids: string[], dir = LISTINGS_DIR): Promise<void> {
  const listings = await listListings(dir);
  await saveSidebarOrder(dir, ids, listings.map((listing) => listing.id));
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
    sourceUrl: meta.sourceUrl ?? null,
    location: meta.location ?? null,
    description: meta.description ?? "",
    thumbnail: files.includes(meta.thumbnail ?? "") ? meta.thumbnail! : files[0] ?? null,
    dir,
    deletedAt: meta.deletedAt ?? null,
    photos: files.map((file) => ({ file, room: meta.photos[file]?.room ?? "", selected: meta.photos[file]?.selected ?? true, ...(meta.photos[file]?.quality ? { quality: meta.photos[file]!.quality } : {}) })),
  };
}

export async function saveSelection(dir: string, photos: Array<{ file: string; room?: string; selected?: boolean; quality?: string }>): Promise<Listing> {
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
            quality: update?.quality ?? photo.quality,
          },
        ];
      }),
    ),
  };
  await writeFile(metaPath, `${JSON.stringify(next, null, 2)}\n`);
  return readListing(dir);
}

export async function setListingThumbnail(dir: string, file: string): Promise<Listing> {
  const listing = await readListing(dir);
  if (!listing.photos.some(photo => photo.file === file)) throw Object.assign(new Error("Choose a photo from this listing."), { status: 400 });
  const metaPath = path.join(dir, "listing.json");
  const meta = existsSync(metaPath) ? JSON.parse(await readFile(metaPath, "utf8")) : {};
  await writeFile(metaPath, `${JSON.stringify({ ...meta, thumbnail: file }, null, 2)}\n`);
  return readListing(dir);
}

/** Automatic cover selection respects any explicitly saved thumbnail. */
export async function setAutomaticThumbnail(dir: string, file: string): Promise<Listing> {
  const metaPath = path.join(dir, "listing.json");
  const meta = existsSync(metaPath) ? JSON.parse(await readFile(metaPath, "utf8")) : {};
  const listing = await readListing(dir);
  if (listing.photos.some(p => p.file === meta.thumbnail)) return listing;
  return setListingThumbnail(dir, file);
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

/** Copy source photos and their labels into an independent listing with fresh run history. */
export async function duplicateListing(id: string): Promise<Listing> {
  const dir = listingDir(id);
  if (!existsSync(dir)) throw Object.assign(new Error("Listing not found"), { status: 404 });
  const source = await readListing(dir);
  if (source.deletedAt) throw Object.assign(new Error("Listing not found"), { status: 404 });
  const metaPath = path.join(dir, "listing.json");
  const meta = existsSync(metaPath) ? JSON.parse(await readFile(metaPath, "utf8")) : {};
  const copy = await createListing({ name: `Copy of ${source.name}` });
  try {
    for (const photo of source.photos) await copyFile(path.join(dir, photo.file), path.join(copy.dir, photo.file));
    await writeFile(path.join(copy.dir, "listing.json"), `${JSON.stringify({ ...meta, name: copy.name, deletedAt: null }, null, 2)}\n`);
    return await readListing(copy.dir);
  } catch (error) {
    await rm(copy.dir, { recursive: true, force: true });
    throw error;
  }
}


type Fingerprints = Array<{ file: string; print: Buffer }>;

/** Normalize an uploaded listing photo (EXIF rotation, size cap, JPEG), refuse near-duplicates, continue numbering. */
export async function addListingPhoto(dir: string, bytes: Buffer, known?: Fingerprints): Promise<string> {
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
  // Batch imports pass the prints they've already computed, so each photo isn't re-read for every new one.
  const prints = known ?? await Promise.all(listing.photos.map(async (photo) => ({ file: photo.file, print: await imageFingerprint(path.join(dir, photo.file)) })));
  const dup = prints.find((p) => isNearDuplicate(p.print, print));
  if (dup) throw Object.assign(new Error(`Already in this listing as ${dup.file}.`), { status: 409 });
  const next = Math.max(0, ...listing.photos.map((p) => Number(p.file.match(/-(\d+)\.\w+$/)?.[1] ?? 0))) + 1;
  const file = `${listing.id}-${String(next).padStart(2, "0")}.jpg`;
  await sharp(bytes)
    .rotate()
    .resize({ width: MAX_PHOTO_EDGE, height: MAX_PHOTO_EDGE, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#fff" })
    .jpeg({ quality: 90, mozjpeg: true })
    .toFile(path.join(dir, file));
  await saveSelection(dir, [{ file, room: "", selected: true }]);
  known?.push({ file, print });
  return file;
}

export type WebImport = { listing: Listing; site: string; url: string; found: number; added: number; skipped: number; failed: number };

/** Add a listing page's photos to a listing, skipping duplicates and stopping at the photo cap. */
export async function addPhotosFromWeb(dir: string, page: ScrapeResult, fetchFn: typeof fetch = fetch): Promise<WebImport> {
  const start = await readListing(dir);
  const room = Math.max(0, MAX_LISTING_PHOTOS - start.photos.length);
  if (!room) throw Object.assign(new Error(`A listing can hold up to ${MAX_LISTING_PHOTOS} photos.`), { status: 400 });
  // Duplicates are skipped, so fetch a few past the cap in case some don't make it in.
  const downloads = await downloadPhotos(page.photos.slice(0, room + 8), page.url, fetchFn);
  const prints: Fingerprints = await Promise.all(start.photos.map(async (photo) => ({ file: photo.file, print: await imageFingerprint(path.join(dir, photo.file)) })));
  let added = 0, skipped = 0, failed = downloads.filter((bytes) => !bytes).length;
  for (const bytes of downloads) {
    if (!bytes || added >= room) continue;
    try {
      await addListingPhoto(dir, bytes, prints);
      added += 1;
    } catch (error) {
      if ((error as { status?: number }).status === 409) skipped += 1; else failed += 1;
    }
  }
  const metaPath = path.join(dir, "listing.json");
  const meta = existsSync(metaPath) ? JSON.parse(await readFile(metaPath, "utf8")) : {};
  await writeFile(metaPath, `${JSON.stringify({ ...meta, source: SITE_NAMES[page.site], sourceUrl: page.url }, null, 2)}\n`);
  return { listing: await readListing(dir), site: SITE_NAMES[page.site], url: page.url, found: page.photos.length, added, skipped, failed };
}

/** New listing from a Redfin/Zillow/Compass link or an address: read the page, then pull its photos. */
export async function createListingFromWeb(input: { link: string; name?: string; location?: string | null; description?: string }, fetchFn: typeof fetch = fetch): Promise<WebImport> {
  const page = await scrapeListing(input.link, fetchFn);
  const listing = await createListing({
    name: input.name?.trim() || page.street || addressFromUrl(page.url) || SITE_NAMES[page.site],
    location: input.location?.trim() || page.locality,
    description: input.description,
  });
  try {
    const result = await addPhotosFromWeb(listing.dir, page, fetchFn);
    if (!result.added) throw Object.assign(new Error(`Found ${page.photos.length} photos on ${result.site} but couldn't download any of them. Try again, or add the photos yourself.`), { status: 502 });
    return result;
  } catch (error) {
    await rm(listing.dir, { recursive: true, force: true });
    throw error;
  }
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

/** Retain source photos and run history so deletion can be undone. */
async function setListingDeletedAt(id: string, deletedAt: string | null): Promise<void> {
  const dir = listingDir(id);
  if (!existsSync(dir)) throw Object.assign(new Error("Listing not found"), { status: 404 });
  const metaPath = path.join(dir, "listing.json");
  const meta = existsSync(metaPath) ? JSON.parse(await readFile(metaPath, "utf8")) : {};
  await writeFile(metaPath, `${JSON.stringify({ ...meta, deletedAt }, null, 2)}\n`);
}

export async function deleteListing(id: string): Promise<void> {
  await setListingDeletedAt(id, new Date().toISOString());
}

export async function restoreListing(id: string): Promise<void> {
  await setListingDeletedAt(id, null);
}
