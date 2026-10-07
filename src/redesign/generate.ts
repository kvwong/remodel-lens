import OpenAI, { toFile } from "openai";

import type { RoomInventory } from "../listing/inventory.js";
import { createLimiter } from "../files.js";
import { withRetries } from "../providers.js";
import type { TasteProfile } from "../taste/schema.js";
import { PRACTICAL_CONSTRAINTS, roomNotesFor, type ChangePlan } from "./plan.js";

export function editPrompt(input: {
  inventory: RoomInventory;
  plan: ChangePlan;
  profile: TasteProfile;
  feedback?: string | undefined;
}): string {
  const { inventory, plan, profile } = input;
  const OPENINGS = new Set(["window", "exterior_door", "interior_door", "doorway_opening", "skylight"]);
  const fixed = inventory.fixed
    .filter((item) => plan.tier !== "major" || !["interior_door", "doorway_opening"].includes(item.kind))
    .map((item) =>
      OPENINGS.has(item.kind)
        ? `- ${item.kind.replace(/_/g, " ")} opening (exact position, size, and count; frame and trim only as listed under CHANGE): ${item.description}`
        : `- ${item.kind.replace(/_/g, " ")}: ${item.description}`,
    );

  return [
    `Photorealistic interior remodel of this exact ${inventory.roomType}, as a real-estate photo taken after renovation.`,
    "",
    "KEEP IDENTICAL (same position, size, shape, and count):",
    "- Camera position, height, lens, and perspective. Do not reframe, crop, or zoom.",
    "- Room dimensions, ceiling height, and floor plane.",
    "- Every wall-to-ceiling junction and ceiling line stays at the same position in the image. Removing coffers or soffits exposes a ceiling at the existing height; never raise or reshape it.",
    "- Each window and door opening keeps its wall edges (head, jambs, sill) at the same position in the image. Where casing or trim is removed, the area it covered becomes wall surface, not glass. Separate window units stay separate, with the wall or post between them intact; transoms stay transoms.",
    "- Fireplace firebox opening keeps its exact size and position; only the surround and mantel may change if listed.",
    ...fixed,
    ...plan.preserve.map((item) => `- ${item}`),
    plan.tier === "major"
      ? `- All walls except: ${plan.removedWalls.join("; ") || "none"}.`
      : "- Every wall and doorway. Do not add or remove openings.",
    "",
    "CHANGE ONLY THESE:",
    ...plan.changes.map((change) => `- ${change.element}: ${change.current} → ${change.proposed}`),
    "",
    "REALISM:",
    ...PRACTICAL_CONSTRAINTS.map((c) => `- ${c}`),
    `- Architectural language: ${plan.architecturalLanguage}`,
    ...(plan.expression ? [`- Expression: ${plan.expression}${(() => { const e = profile.expressions.find((x) => x.name.toLowerCase() === plan.expression.toLowerCase()); return e ? ` (${e.description})` : ""; })()}`] : []),
    "",
    `STYLE DIRECTION: ${profile.imagePromptSummary}`,
    ...roomNotesFor(profile, inventory.roomType).flatMap((room) => [`${room.room.toUpperCase()} DIRECTION:`, ...room.notes.map((n) => `- ${n}`)]),
    `AVOID: ${profile.globalAvoid.join(", ")}.`,
    "",
    "Render accurate material textures, shadows, and material junctions. Natural exposure with daylight consistent with the existing windows. No people, text, or watermarks.",
    ...(input.feedback ? ["", `A previous attempt failed verification. Fix this: ${input.feedback}`] : []),
  ].join("\n");
}

/**
 * gpt-image-2.5 models return a black fill wherever an alpha mask is transparent (tested 2026-10-03,
 * with both black and white mask RGB). They scope edits to the instruction well without one, so
 * they get prompt-only edits; older GPT image models still get the mask.
 */
export function supportsMask(model: string): boolean {
  return !/^gpt-image-2\.5/.test(model);
}

export const DEFAULT_IMAGE_CONCURRENCY = 6;

/** Image edits allowed in flight at once. Set on the Settings page or with IMAGE_CONCURRENCY; lower it if OpenAI rate-limits. */
export function imageConcurrency(): number {
  const value = Math.floor(Number(process.env.IMAGE_CONCURRENCY));
  return value >= 1 ? Math.min(value, 16) : DEFAULT_IMAGE_CONCURRENCY;
}

/** Shared across every run in this process, so parallel listings don't multiply image-API load. */
const imageSlots = createLimiter(imageConcurrency);

export async function editImage(input: {
  model: string;
  image: Buffer;
  mask: Buffer | null;
  prompt: string;
  /** Extra images after the one being edited (a marked-up copy, reference photos). They're context only; image 1 is edited. */
  references?: Buffer[];
}): Promise<Buffer> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await imageSlots(() => withRetries(async () =>
    client.images.edit({
      model: input.model,
      image: input.references?.length
        ? [
            await toFile(input.image, "listing.png", { type: "image/png" }),
            ...(await Promise.all(input.references.map((bytes, i) => toFile(bytes, `reference-${i + 1}.png`, { type: "image/png" })))),
          ]
        : await toFile(input.image, "listing.png", { type: "image/png" }),
      ...(input.mask ? { mask: await toFile(input.mask, "mask.png", { type: "image/png" }) } : {}),
      prompt: input.prompt,
      size: "auto",
      quality: "high",
      n: 1,
    }),
  ));
  const b64 = response.data?.[0]?.b64_json;
  if (!b64) throw new Error(`${input.model} returned no image.`);
  return Buffer.from(b64, "base64");
}
