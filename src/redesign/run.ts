import type { Models } from "../config.js";
import { isCancelled, log, mapLimit, progressAdd, progressDone, writeArtifact, writeJson, type LocalImage } from "../files.js";
import { inventoryRoom, type BoxTuple, type RoomInventory } from "../listing/inventory.js";
import type { TasteProfile } from "../taste/schema.js";
import { editImage, editPrompt, imageConcurrency, supportsMask } from "./generate.js";
import { buildMask, editableBoxes, editableShare, prepareImage, protectedBoxes } from "./mask.js";
import { planRedesign, type ChangePlan } from "./plan.js";
import { allowedAt, type Tier } from "./tiers.js";
import { edgeChecks, judge, verdict, type EdgeCheck, type JudgeResult, type Verdict } from "./verify.js";

export type TierResult = {
  tier: Tier;
  plan: ChangePlan;
  status: Verdict | "unchanged" | "error";
  reasons: string[];
  warnings: string[];
  attempts: number;
  editableShare: number | null;
  image: string | null; // path relative to the run dir
  edges: EdgeCheck[];
  judgement: JudgeResult | null;
};

export type PhotoResult = {
  id: string;
  basename: string;
  /** Owner's room label when given, else the inventory's room type. */
  room?: string;
  original: string;
  inventory: RoomInventory;
  tiers: TierResult[];
};

const MAX_ATTEMPTS = 2;

// Progress weights: image generation dominates wall-clock time.
const UNITS = { inventory: 1, plan: 1, generate: 3, verify: 1 } as const;
const TIER_UNITS = UNITS.plan + UNITS.generate + UNITS.verify;

/** Tracks one tier's share of the progress bar so errors and skips can settle the remainder. */
type TierBudget = { budget: number; spent: number };
function spend(b: TierBudget, units: number, label: string) {
  b.spent += units;
  progressDone(units, label);
}

export async function redesignListing(input: {
  photos: LocalImage[];
  profile: TasteProfile;
  tiers: Tier[];
  models: Models;
  outDir: string;
  location?: string | null;
}): Promise<PhotoResult[]> {
  progressAdd(input.photos.length * (UNITS.inventory + input.tiers.length * TIER_UNITS));
  // Enough photos in flight to keep every image slot busy; edits queue in order for the shared slots.
  const results = await mapLimit(input.photos, Math.max(3, imageConcurrency()), (photo) => redesignPhoto({ ...input, photo }));
  return results.filter((r): r is PhotoResult => r !== null);
}

async function redesignPhoto(input: {
  photo: LocalImage;
  profile: TasteProfile;
  tiers: Tier[];
  models: Models;
  outDir: string;
  location?: string | null;
}): Promise<PhotoResult | null> {
  const { photo, profile, models, outDir, location } = input;
  if (isCancelled()) return null;
  const prepared = await prepareImage(photo.bytes);
  const original = `${photo.id}/original.png`;
  await writeArtifact(outDir, original, prepared.png);

  log(`${photo.id}: inventorying ${photo.basename}`);
  const inventory = await inventoryRoom({ ...photo, bytes: prepared.png, mediaType: "image/png" }, models.planner ?? models.reasoning);
  await writeJson(outDir, `${photo.id}/inventory.json`, inventory);
  progressDone(UNITS.inventory, `${photo.basename}: inventoried`);

  // Scopes only depend on the inventory, so they plan, generate, and verify side by side.
  const settled = await Promise.all(input.tiers.map(async (tier): Promise<TierResult | null> => {
    if (isCancelled()) {
      progressDone(TIER_UNITS, `${photo.basename} ${tier}: stopped`);
      return null;
    }
    const budget: TierBudget = { budget: TIER_UNITS, spent: 0 };
    try {
      return await redesignTier({ photo, prepared, inventory, profile, tier, models, outDir, location, budget });
    } catch (error) {
      progressDone(budget.budget - budget.spent, `${photo.basename} ${tier}: error`);
      const message = error instanceof Error ? error.message : String(error);
      log(`${photo.id} ${tier}: error — ${message}`);
      return {
        tier,
        plan: { tier, expression: "", architecturalLanguage: "", changes: [], removedWalls: [], preserve: [], feasibilityFlags: [], beyondScope: [], rationale: "" },
        status: "error",
        reasons: [message],
        warnings: [],
        attempts: 0,
        editableShare: null,
        image: null,
        edges: [],
        judgement: null,
      };
    }
  }));
  const tiers = settled.filter((t): t is TierResult => t !== null);
  if (tiers.length === 0) return null;
  return { id: photo.id, basename: photo.basename, room: photo.roomHint || inventory.roomType, original, inventory, tiers };
}

async function redesignTier(input: {
  photo: LocalImage;
  prepared: { png: Buffer; width: number; height: number };
  inventory: RoomInventory;
  profile: TasteProfile;
  tier: Tier;
  models: Models;
  outDir: string;
  location?: string | null;
  budget: TierBudget;
}): Promise<TierResult> {
  const { photo, prepared, inventory, profile, tier, models, outDir, location, budget } = input;
  const dir = `${photo.id}/${tier}`;

  log(`${photo.id} ${tier}: planning`);
  const plan = await planRedesign({ inventory, profile, tier, model: models.planner ?? models.reasoning, location });
  await writeJson(outDir, `${dir}/plan.json`, plan);
  spend(budget, UNITS.plan, `${photo.basename} ${tier}: planned`);
  const warnings: string[] = [];

  if (plan.changes.length === 0) {
    spend(budget, UNITS.generate + UNITS.verify, `${photo.basename} ${tier}: no changes needed`);
    return { tier, plan, status: "unchanged", reasons: ["Room already fits the taste at this tier."], warnings, attempts: 0, editableShare: null, image: null, edges: [], judgement: null };
  }

  let editable = editableBoxes(inventory, plan);
  if (editable.length === 0) {
    warnings.push("Planned changes didn't match inventory items; opened every changeable item allowed at this tier.");
    editable = inventory.changeable.filter((item) => allowedAt(item.minTier, tier)).map((item) => item.box as BoxTuple);
  }
  // The mask is still written for debugging even when the model doesn't receive it.
  const mask = await buildMask({ width: prepared.width, height: prepared.height, editable, ...protectedBoxes(inventory, tier, plan) });
  await writeArtifact(outDir, `${dir}/mask.png`, mask);
  const useMask = supportsMask(models.image);
  const share = useMask ? await editableShare(mask) : null;
  if (!useMask) warnings.push(`${models.image} edits from the prompt alone (no mask); verification checks that fixed elements held.`);

  let feedback: string | undefined;
  let last: Omit<TierResult, "tier" | "plan" | "warnings" | "editableShare"> | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (isCancelled()) {
      if (last) break; // keep the first attempt's result rather than retrying
      spend(budget, budget.budget - budget.spent, `${photo.basename} ${tier}: stopped`);
      return { tier, plan, warnings, editableShare: share, status: "error", reasons: ["Stopped before this image was generated."], attempts: 0, image: null, edges: [], judgement: null };
    }
    log(`${photo.id} ${tier}: generating (attempt ${attempt})`);
    if (attempt > 1) {
      budget.budget += UNITS.generate + UNITS.verify;
      progressAdd(UNITS.generate + UNITS.verify);
    }
    const prompt = editPrompt({ inventory, plan, profile, feedback });
    await writeArtifact(outDir, `${dir}/prompt-${attempt}.txt`, prompt);
    const redesign = await editImage({ model: models.image, image: prepared.png, mask: useMask ? mask : null, prompt });
    const image = `${dir}/redesign-${attempt}.png`;
    await writeArtifact(outDir, image, redesign);

    spend(budget, UNITS.generate, `${photo.basename} ${tier}: generated (attempt ${attempt})`);
    log(`${photo.id} ${tier}: verifying`);
    const [edges, judgement] = await Promise.all([
      edgeChecks(prepared.png, redesign, inventory),
      judge({ model: models.reasoning, original: prepared.png, redesign, inventory, plan }),
    ]);
    const result = verdict(edges, judgement);
    await writeJson(outDir, `${dir}/verify-${attempt}.json`, { ...result, edges, judgement });
    last = { status: result.verdict, reasons: result.reasons, attempts: attempt, image, edges, judgement };
    spend(budget, UNITS.verify, `${photo.basename} ${tier}: ${result.verdict}`);
    if (result.verdict !== "failed") break;
    feedback = result.reasons.join(" ");
  }

  return { tier, plan, warnings, editableShare: share, ...last! };
}
