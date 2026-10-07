import { createHash } from "node:crypto";
import { cachedImage } from "../image-cache.js";
import sharp from "sharp";

import type { BoxTuple, RoomInventory } from "../listing/inventory.js";
import type { ChangePlan } from "./plan.js";
import type { Tier } from "./tiers.js";

/** Always protected, at every tier. These define whether the house is the same house. */
const HARD_PROTECTED = new Set(["window", "exterior_door", "skylight", "stair", "beam", "column", "fireplace", "other_structural"]);
/** Protected below major; interior openings can change when walls do. */
const PROTECTED_BELOW_MAJOR = new Set(["interior_door", "doorway_opening", "radiator_or_vent"]);
/** Protected only where no planned change overlaps (ceiling fixtures sit inside the ceiling band). */
const SOFT_PROTECTED = new Set(["ceiling_line", "exterior_wall"]);
// plumbing_location is enforced by the prompt and judge, not the mask: fixtures there may be replaced.

export const MAX_EDGE = 1536;

/** True when the plan touches window/door frames or trim, so openings can't be hard-masked. */
export function changesOpeningComponents(plan: ChangePlan | undefined): boolean {
  return !!plan?.changes.some((c) => /window|casing|trim|sash|frame|door/i.test(c.element));
}

export function protectedBoxes(inventory: RoomInventory, tier: Tier, plan?: ChangePlan): { hard: BoxTuple[]; soft: BoxTuple[] } {
  const hard: BoxTuple[] = [];
  const soft: BoxTuple[] = [];
  const openingsSoft = changesOpeningComponents(plan);
  for (const item of inventory.fixed) {
    const box = item.box as BoxTuple;
    if (openingsSoft && ["window", "exterior_door", "skylight"].includes(item.kind)) soft.push(box);
    else if (HARD_PROTECTED.has(item.kind) || (tier !== "major" && PROTECTED_BELOW_MAJOR.has(item.kind))) hard.push(box);
    else if (SOFT_PROTECTED.has(item.kind)) soft.push(box);
  }
  return { hard, soft };
}

const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function matches(a: string, b: string): boolean {
  const [x, y] = [normalize(a), normalize(b)];
  return x === y || x.includes(y) || y.includes(x);
}

/** Boxes the image model may repaint: inventory items the plan touches, plus removed walls. */
export function editableBoxes(inventory: RoomInventory, plan: ChangePlan): BoxTuple[] {
  const boxes = inventory.changeable
    .filter((item) => plan.changes.some((change) => matches(change.element, item.element)))
    .map((item) => item.box as BoxTuple);
  for (const wall of inventory.walls) {
    if (plan.removedWalls.some((removed) => matches(removed, wall.description))) boxes.push(wall.box as BoxTuple);
  }
  return boxes;
}

/** Resize the listing photo to an API-friendly PNG; the mask must share these exact dimensions. */
export async function prepareImage(bytes: Uint8Array): Promise<{ png: Buffer; width: number; height: number }> {
  const key = `prepared-png-v1:${MAX_EDGE}:${createHash("sha256").update(bytes).digest("hex")}`;
  const data = await cachedImage(key, () => sharp(bytes).rotate()
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
    .png().toBuffer());
  const info = await sharp(data).metadata();
  return { png: data, width: info.width!, height: info.height! };
}

/**
 * OpenAI mask convention: alpha 0 = editable, alpha 255 = keep.
 * Order matters: soft-protect, open editable boxes, then hard-protect on top so fixed elements always win.
 */
export async function buildMask(input: {
  width: number;
  height: number;
  editable: BoxTuple[];
  hard: BoxTuple[];
  soft: BoxTuple[];
  pad?: number;
}): Promise<Buffer> {
  const { width, height } = input;
  const pad = input.pad ?? 15; // on the 0–1000 scale
  const alpha = new Uint8Array(width * height).fill(255);

  const paint = (box: BoxTuple, value: number, padding: number) => {
    const x0 = Math.max(0, Math.floor(((box[0] - padding) / 1000) * width));
    const y0 = Math.max(0, Math.floor(((box[1] - padding) / 1000) * height));
    const x1 = Math.min(width, Math.ceil(((box[2] + padding) / 1000) * width));
    const y1 = Math.min(height, Math.ceil(((box[3] + padding) / 1000) * height));
    for (let y = y0; y < y1; y += 1) alpha.fill(value, y * width + x0, y * width + x1);
  };

  for (const box of input.editable) paint(box, 0, pad);
  for (const box of input.soft) {
    // Re-protect soft regions only where they don't overlap a planned change.
    if (!input.editable.some((e) => overlaps(e, box))) paint(box, 255, pad / 2);
  }
  for (const box of input.hard) paint(box, 255, pad);

  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < alpha.length; i += 1) rgba[i * 4 + 3] = alpha[i]!;
  return sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

export function overlaps(a: BoxTuple, b: BoxTuple): boolean {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}

/** Share of the frame the model is allowed to repaint. Useful for spotting runaway masks. */
export async function editableShare(mask: Buffer): Promise<number> {
  const { data, info } = await sharp(mask).ensureAlpha().extractChannel(3).raw().toBuffer({ resolveWithObject: true });
  let open = 0;
  for (const value of data) if (value === 0) open += 1;
  return open / (info.width * info.height);
}
