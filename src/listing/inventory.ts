import { z } from "zod";

import type { LocalImage } from "../files.js";
import { generateStructured } from "../providers.js";
import { TIERS, TIER_DEFINITIONS } from "../redesign/tiers.js";

/** [x0, y0, x1, y1], normalized 0–1000 from the top-left of the photo. */
export const Box = z.array(z.number()).describe("[x0, y0, x1, y1] normalized 0–1000, top-left origin");

export const FIXED_KINDS = [
  "window",
  "exterior_door",
  "interior_door",
  "doorway_opening",
  "ceiling_line",
  "beam",
  "column",
  "stair",
  "fireplace",
  "exterior_wall",
  "skylight",
  "radiator_or_vent",
  "plumbing_location",
  "other_structural",
] as const;

export const RoomInventory = z.object({
  roomType: z.string(),
  camera: z.string().describe("Viewpoint and lens notes, e.g. 'wide angle from doorway, eye level'."),
  fixed: z.array(
    z.object({
      kind: z.enum(FIXED_KINDS),
      description: z.string(),
      box: Box,
    }),
  ),
  changeable: z.array(
    z.object({
      element: z.string().describe("e.g. 'upper cabinets', 'flooring', 'pendant over sink', 'sofa'"),
      current: z.string().describe("What it is now: material, color, condition."),
      minTier: z.enum(TIERS),
      box: Box,
    }),
  ),
  walls: z.array(
    z.object({
      description: z.string(),
      exterior: z.boolean(),
      possiblyLoadBearing: z.boolean().describe("True unless clearly a non-structural partition. Err toward true."),
      box: Box,
    }),
  ),
  condition: z.string().describe("Visible wear, dated finishes, water damage, etc."),
  uncertainties: z.array(z.string()),
});

export type RoomInventory = z.infer<typeof RoomInventory>;
export type BoxTuple = [number, number, number, number];

export function inventoryPrompt(roomHint?: string): string {
  return `You are inventorying a real-estate listing photo so it can be redesigned realistically. Separate what is fixed (would require structural or exterior work to change) from what is changeable, and say the lowest remodel tier that could change each item.
${roomHint ? `\nThe owner labeled this photo "${roomHint}". Use that as roomType unless the photo clearly shows otherwise.\n` : ""}
Listing photos are often virtually staged: treat all furniture, rugs, and decor as changeable at the cosmetic tier. Ignore MLS watermarks and logos.

Tiers:
${TIERS.map((tier) => `- ${tier}: ${TIER_DEFINITIONS[tier].allowed}`).join("\n")}

Rules:
- Every window, door, doorway, skylight, stair, fireplace, and column visible must appear in "fixed", even partially visible ones. For windows and doors, "fixed" means the OPENING only: its position, size, and count.
- List window and door frames/sashes separately in "changeable" (element "window frames", minTier "major"), and trim separately (element "window and door casings and trim" or "crown and baseboards", minTier "moderate"). Trim is a replaceable component, not just a paint finish.
- Ceiling beams go in "fixed" (kind "beam") only if they look like real structure (rafters, ridge or support beams). Decorative coffers, applied boxed beams, and soffit boxes go in "changeable" with minTier "major".
- List built-in shelving and cabinetry in "changeable" (minTier "moderate"), noting whether it projects from the wall or sits flush.
- Include "ceiling_line" for where walls meet the ceiling, and "plumbing_location" for sinks, toilets, tubs, showers, and the range/gas line.
- Bounding boxes are [x0, y0, x1, y1] on a 0–1000 scale relative to the photo, generous rather than tight.
- List each interior wall plane in "walls". Never state a wall is non-load-bearing unless it is obviously a thin partition; when unsure set possiblyLoadBearing true and add an uncertainty.
- Changeable items: flooring, wall surfaces, cabinetry, counters, backsplash, fixtures, lighting, furniture, decor, window treatments, appliances.
- "current" should be specific about material, color, and condition so a planner can propose a replacement.`;
}

export async function inventoryRoom(image: LocalImage, model: string): Promise<RoomInventory> {
  const inventory = await generateStructured({
    model,
    prompt: inventoryPrompt(image.roomHint),
    schema: RoomInventory,
    images: [image],
  });
  return normalizeInventoryBoxes(inventory);
}

/** Clamp, order, and drop malformed boxes so masks and verification never see garbage. */
export function normalizeBox(box: number[]): BoxTuple | null {
  if (box.length !== 4 || box.some((n) => !Number.isFinite(n))) return null;
  const [a, b, c, d] = box.map((n) => Math.max(0, Math.min(1000, n))) as BoxTuple;
  const out: BoxTuple = [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
  return out[2] - out[0] < 5 || out[3] - out[1] < 5 ? null : out;
}

export function normalizeInventoryBoxes(inventory: RoomInventory): RoomInventory {
  const fix = <T extends { box: number[] }>(items: T[]) =>
    items.flatMap((item) => {
      const box = normalizeBox(item.box);
      return box ? [{ ...item, box }] : [];
    });
  return {
    ...inventory,
    fixed: fix(inventory.fixed),
    changeable: fix(inventory.changeable),
    walls: fix(inventory.walls),
  };
}
