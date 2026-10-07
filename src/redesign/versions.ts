// Spot changes: extra versions of one photo at one scope, appended to a saved run.
// results.json stays as the run wrote it; versions.json beside it holds every later version and which one each room uses.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

import { createLimiter, writeJson } from "../files.js";
import type { BoxTuple, RoomInventory } from "../listing/inventory.js";
import type { PhotoResult, TierResult } from "./run.js";
import type { Tier } from "./tiers.js";

/** A note pinned to one spot. x and y are 0–1000 from the image's top-left, like inventory boxes. */
export type Pin = {
  x: number;
  y: number;
  note: string;
  /** What the pin landed on, from the inventory. */
  item?: string;
  /** True when the pin is on something kept as is (a window, a door opening). */
  fixed?: boolean;
  /** The judge's call on whether the redesign did what the pin asked. */
  result?: "done" | "partial" | "missed";
  resultNote?: string;
};

export type ChangeRequest = {
  /** Change for the whole room; may be empty when pins carry the ask. */
  ask: string;
  /** Extra context, e.g. "we're keeping the range". */
  notes: string;
  pins: Pin[];
  /** Reference photo files, relative to the run dir. */
  references: string[];
};

/** "v1" is always the run's own result; spot changes are v2, v3, … per photo and scope. */
export const ORIGINAL = "v1";

export type Version = Omit<TierResult, "status"> & {
  id: string;
  photoId: string;
  /** The version this change started from. */
  parent: string;
  request: ChangeRequest;
  createdAt: string;
  status: TierResult["status"] | "running";
  /** Estimated API spend in USD. */
  apiCost: number;
};

export type VersionsFile = {
  versions: Version[];
  /** `${photoId}:${tier}` → version id the report, totals, and PDFs use. Missing means the original. */
  picks: Record<string, string>;
};

export const pickKey = (photoId: string, tier: Tier) => `${photoId}:${tier}`;

const FILE = "versions.json";

export async function readVersions(runDir: string): Promise<VersionsFile> {
  const file = path.join(runDir, FILE);
  if (!existsSync(file)) return { versions: [], picks: {} };
  const raw = JSON.parse(await readFile(file, "utf8")) as Partial<VersionsFile>;
  return { versions: raw.versions ?? [], picks: raw.picks ?? {} };
}

// One writer per run dir at a time, so two changes finishing together can't drop each other's entry.
const locks = new Map<string, ReturnType<typeof createLimiter>>();
export async function updateVersions<T>(runDir: string, change: (file: VersionsFile) => T | Promise<T>): Promise<T> {
  const key = path.resolve(runDir);
  let lock = locks.get(key);
  if (!lock) locks.set(key, (lock = createLimiter(1)));
  return lock(async () => {
    const file = await readVersions(runDir);
    const result = await change(file);
    await writeJson(runDir, FILE, file);
    return result;
  });
}

/** Next version id for one photo and scope: v2 for the first change. */
export function nextVersionId(file: VersionsFile, photoId: string, tier: Tier): string {
  const used = file.versions.filter((v) => v.photoId === photoId && v.tier === tier).map((v) => Number(v.id.slice(1)) || 0);
  return `v${Math.max(1, ...used) + 1}`;
}

/** Versions of one photo and scope, oldest first, not counting the original. */
export function versionsFor(file: VersionsFile, photoId: string, tier: Tier): Version[] {
  return file.versions.filter((v) => v.photoId === photoId && v.tier === tier).sort((a, b) => (Number(a.id.slice(1)) || 0) - (Number(b.id.slice(1)) || 0));
}

/** A finished version in the shape of a scope result, for the report and pricing. */
export function asTierResult(version: Version): TierResult {
  const { tier, plan, reasons, warnings, attempts, editableShare, image, edges, judgement } = version;
  return { tier, plan, status: version.status === "running" ? "error" : version.status, reasons, warnings, attempts, editableShare, image, edges, judgement };
}

/** The run's results with each room's picked version in place of the original. */
export function applyPicks(photos: PhotoResult[], file: VersionsFile): PhotoResult[] {
  return photos.map((photo) => ({
    ...photo,
    tiers: photo.tiers.map((t) => {
      const id = file.picks[pickKey(photo.id, t.tier)];
      const picked = id && id !== ORIGINAL ? file.versions.find((v) => v.id === id && v.photoId === photo.id && v.tier === t.tier) : null;
      return picked && picked.status !== "running" && picked.image ? asTierResult(picked) : t;
    }),
  }));
}

/** Total estimated API spend on spot changes in a run. */
export function changesCost(file: VersionsFile): number {
  return file.versions.reduce((sum, v) => sum + (v.apiCost ?? 0), 0);
}

const area = (b: BoxTuple) => Math.max(1, (b[2] - b[0]) * (b[3] - b[1]));
const inside = (b: BoxTuple, x: number, y: number) => x >= Math.min(b[0], b[2]) && x <= Math.max(b[0], b[2]) && y >= Math.min(b[1], b[3]) && y <= Math.max(b[1], b[3]);

function where(x: number, y: number): string {
  const row = y < 333 ? "upper" : y < 667 ? "middle" : "lower";
  const col = x < 333 ? "left" : x < 667 ? "center" : "right";
  return row === "middle" && col === "center" ? "center of the image" : `${row} ${col} of the image`;
}

/** Names what each pin landed on: the smallest inventory box it falls in, fixed elements included. */
export function snapPins(pins: Pin[], inventory: RoomInventory): Pin[] {
  const boxes = [
    ...inventory.changeable.map((c) => ({ item: c.element, box: c.box as BoxTuple, fixed: false })),
    ...inventory.fixed.map((f) => ({ item: f.description || f.kind.replace(/_/g, " "), box: f.box as BoxTuple, fixed: true })),
  ].filter((b) => b.box.length === 4);
  return pins.map((pin) => {
    const hit = boxes.filter((b) => inside(b.box, pin.x, pin.y)).sort((a, b) => area(a.box) - area(b.box))[0];
    return { ...pin, item: hit?.item ?? where(pin.x, pin.y), fixed: hit?.fixed ?? false };
  });
}

/** The image with numbered markers where each pin sits, so the image model can see which spot each note means. */
export async function markPins(png: Buffer, pins: Pin[]): Promise<Buffer> {
  const { width = 1024, height = 768 } = await sharp(png).metadata();
  const r = Math.max(14, Math.round(Math.min(width, height) * 0.03));
  const marks = pins.map((pin, i) => {
    const cx = Math.round((pin.x / 1000) * width), cy = Math.round((pin.y / 1000) * height);
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#e0245e" stroke="#fff" stroke-width="${Math.round(r / 5)}"/><text x="${cx}" y="${cy + Math.round(r * 0.38)}" font-family="Arial, sans-serif" font-weight="700" font-size="${Math.round(r * 1.1)}" fill="#fff" text-anchor="middle">${i + 1}</text>`;
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${marks.join("")}</svg>`;
  return sharp(png).composite([{ input: Buffer.from(svg) }]).png().toBuffer();
}

/** Pin position in words, for prompts. */
export function pinLine(pin: Pin, index: number): string {
  return `${index + 1}. At ${pin.item ?? where(pin.x, pin.y)} (marker ${index + 1}, about ${Math.round(pin.x / 10)}% from the left and ${Math.round(pin.y / 10)}% from the top): ${pin.note}`;
}
