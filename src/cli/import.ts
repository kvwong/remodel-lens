#!/usr/bin/env node
// Usage: npm run import -- <source-folder-or-files…> --id <listing-id> [--name "Display Name"] [--sheet contact.jpg]
// Converts photos (JPG/PNG/WebP/TIFF) into listings/<id>/, applying EXIF rotation, capping size,
// skipping near-duplicates, and continuing the existing numbering. New photos start selected.
import { existsSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import sharp from "sharp";

import { log } from "../files.js";
import { listingDir, readListing } from "../listing/listing.js";

const SOURCE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff"]);
const MAX_EDGE = 2560;

async function fingerprint(input: string | Buffer): Promise<Buffer> {
  return sharp(input).rotate().greyscale().resize(32, 24, { fit: "fill" }).raw().toBuffer();
}

/** Mean absolute pixel difference on a 32×24 greyscale thumbnail; under ~4 is the same shot. */
export function isNearDuplicate(a: Buffer, b: Buffer): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff += Math.abs(a[i]! - b[i]!);
  return diff / a.length < 4;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { id: { type: "string" }, name: { type: "string" }, sheet: { type: "string" } },
  });
  if (!values.id || positionals.length === 0) throw new Error('Usage: npm run import -- <source…> --id <listing-id> [--name "Name"]');

  const sources: string[] = [];
  for (const input of positionals.map((p) => path.resolve(p))) {
    if (statSync(input).isDirectory()) {
      for (const f of (await readdir(input)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
        if (SOURCE_EXTENSIONS.has(path.extname(f).toLowerCase())) sources.push(path.join(input, f));
      }
    } else sources.push(input);
  }

  const dir = listingDir(values.id);
  await mkdir(dir, { recursive: true });
  const existing = await readListing(dir);
  const prints = await Promise.all(existing.photos.map(async (p) => ({ file: p.file, print: await fingerprint(path.join(dir, p.file)) })));
  const numbers = existing.photos.map((p) => Number(p.file.match(/-(\d+)\.\w+$/)?.[1] ?? 0));
  let next = Math.max(0, ...numbers);

  const added: string[] = [];
  for (const source of sources) {
    const print = await fingerprint(source);
    const dup = prints.find((p) => isNearDuplicate(p.print, print));
    if (dup) {
      log(`${path.basename(source)}: duplicate of ${dup.file}, skipped`);
      continue;
    }
    const file = `${values.id}-${String(++next).padStart(2, "0")}.jpg`;
    await sharp(source)
      .rotate()
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#fff" })
      .jpeg({ quality: 90, mozjpeg: true })
      .toFile(path.join(dir, file));
    prints.push({ file, print });
    added.push(file);
    log(`${path.basename(source)} → ${file}`);
  }

  // Keep any existing metadata; set the display name on first import.
  const metaPath = path.join(dir, "listing.json");
  const meta = existsSync(metaPath) ? JSON.parse(await readFile(metaPath, "utf8")) : { photos: {} };
  if (values.name) meta.name = values.name;
  meta.photos ??= {};
  for (const file of added) meta.photos[file] ??= { room: "", selected: true };
  await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`);

  if (values.sheet) {
    const all = (await readListing(dir)).photos;
    const cols = 4;
    const tiles = await Promise.all(
      all.map(async (p, i) => ({
        input: await sharp(path.join(dir, p.file))
          .resize(360, 240, { fit: "cover" })
          .composite([{ input: Buffer.from(`<svg width="360" height="240"><rect width="92" height="26" fill="rgba(0,0,0,.65)"/><text x="8" y="18" font-family="sans-serif" font-size="15" fill="#fff">${p.file.match(/-(\d+)\./)?.[1]}</text></svg>`), left: 0, top: 0 }])
          .toBuffer(),
        left: (i % cols) * 365,
        top: Math.floor(i / cols) * 245,
      })),
    );
    await sharp({ create: { width: cols * 365, height: Math.ceil(all.length / cols) * 245, channels: 3, background: "#fff" } })
      .composite(tiles)
      .jpeg({ quality: 82 })
      .toFile(path.resolve(values.sheet));
  }

  log(`${values.id}: added ${added.length}, ${existing.photos.length + added.length} photos total`);
}

main().catch((error) => {
  log(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
