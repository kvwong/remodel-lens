// One spot change: re-plan, redraw, and re-check a single photo at one scope, starting from the version being viewed.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type { Models } from "../config.js";
import { API_COST } from "../costs.js";
import { isCancelled, log, progressAdd, progressDone, writeArtifact, writeJson } from "../files.js";
import type { RoomInventory } from "../listing/inventory.js";
import { listingDir, readListing } from "../listing/listing.js";
import { priceChanges } from "../pricing/price.js";
import { generateStructured, type ImageInput } from "../providers.js";
import type { TasteProfile } from "../taste/schema.js";
import { editImage } from "./generate.js";
import { loadProfile, type RunSummary } from "./job.js";
import { ChangePlan, enforceTier, PRACTICAL_CONSTRAINTS, tasteBrief } from "./plan.js";
import type { PhotoResult, TierResult } from "./run.js";
import { TIER_DEFINITIONS, TIER_LABELS, TIERS, type Tier } from "./tiers.js";
import { edgeChecks, judge, verdict, type JudgeResult } from "./verify.js";
import { markPins, nextVersionId, ORIGINAL, pinLine, snapPins, updateVersions, versionsFor, type ChangeRequest, type Pin, type Version } from "./versions.js";

const MAX_ATTEMPTS = 2;

export function revisePrompt(input: {
  inventory: RoomInventory;
  profile: TasteProfile | null;
  plan: ChangePlan;
  tier: Tier;
  request: ChangeRequest;
  location?: string | null;
}): string {
  const { inventory, plan, tier, request } = input;
  const higher = TIERS.slice(TIERS.indexOf(tier) + 1);
  return `You are revising the plan behind one redesigned listing photo. The buyer looked at the redesign (image 1) and asked for specific changes. Return the complete revised plan.

Scope: ${tier} (${TIER_LABELS[tier].name})
Allowed at this scope: ${TIER_DEFINITIONS[tier].allowed}

What the buyer asked:
${request.ask ? `- For the whole room: ${request.ask}` : "- Nothing for the whole room; see the pinned notes."}
${request.pins.length ? `Pinned notes (image 2 shows numbered markers where each one is):\n${request.pins.map(pinLine).join("\n")}` : ""}
${request.notes ? `Context from the buyer: ${request.notes}` : ""}
${request.references.length ? `Images ${request.pins.length ? 3 : 2} onward are reference photos the buyer likes. Match their materials, colors, and finishes, not their rooms.` : ""}

How to revise:
- Change only what the buyer's asks touch. Every other change in the current plan stays exactly as it is: same element, proposed text, costItem, quantity, and grade.
- An ask can modify an existing change, add a change for an inventory item, or remove a change (put the item back in "preserve").
- Name materials and finishes a contractor could source, and re-measure quantity when the area changes.
- Only change items whose minTier is at or below "${tier}". If an ask needs more than this scope${higher.length ? ` (${higher.map((t) => TIER_LABELS[t].name).join(" or ")})` : ""}, don't render it: do the closest honest version within scope, or leave the item, and add the real work to beyondScope naming the scope it needs.
- A pin on a window, door opening, ceiling, or other fixed element can't move or resize it. Change only its finish if this scope allows; otherwise explain in beyondScope.
- Never move, resize, add, or remove window or door openings, stairs, or the ceiling plane.
${PRACTICAL_CONSTRAINTS.map((c) => `- ${c}`).join("\n")}
- Keep the plan's expression and architectural language unless the buyer asked otherwise.
- Write a one-sentence rationale saying what changed and why.

Current plan (JSON):
${JSON.stringify(input.plan, null, 2)}

Room inventory (JSON):
${JSON.stringify(inventory, null, 2)}

${input.profile ? `Taste profile, for anything the buyer left open:\n${tasteBrief(input.profile)}` : ""}`;
}

export function changePrompt(input: {
  inventory: RoomInventory;
  plan: ChangePlan;
  previous: ChangePlan;
  request: ChangeRequest;
  marked: boolean;
  feedback?: string | undefined;
}): string {
  const { inventory, plan, previous, request } = input;
  const before = new Map(previous.changes.map((c) => [c.element.toLowerCase(), c.proposed]));
  const edits = plan.changes.filter((c) => before.get(c.element.toLowerCase()) !== c.proposed);
  const kept = new Set(plan.changes.map((c) => c.element.toLowerCase()));
  const reverted = previous.changes.filter((c) => !kept.has(c.element.toLowerCase()));
  const openings = inventory.fixed.filter((f) => ["window", "exterior_door", "interior_door", "doorway_opening", "skylight"].includes(f.kind));
  let n = 1;
  const refStart = input.marked ? 3 : 2;
  return [
    `Edit image 1, a photorealistic remodel of this ${inventory.roomType}. Make only the changes below and keep everything else in image 1 exactly as it is: the same camera, framing, light, materials, colors, furniture, and every other surface.`,
    "",
    "CHANGE:",
    ...(request.ask ? [`- ${request.ask}`] : []),
    ...request.pins.map((pin, i) => `- ${pinLine(pin, i)}`),
    ...edits.map((c) => `- ${c.element}: ${c.proposed}`),
    ...reverted.map((c) => `- ${c.element}: return to how it is in the listing (${c.current})`),
    ...(request.notes ? ["", `Context: ${request.notes}`] : []),
    "",
    ...(input.marked
      ? [`Image ${++n} is image 1 with numbered red markers showing where each pinned change goes. The markers are only directions: never draw circles, numbers, or markers in the result.`]
      : []),
    ...(request.references.length ? [`Images ${refStart}–${refStart + request.references.length - 1} are reference photos. Match their materials and finishes on the items being changed; do not copy their rooms.`] : []),
    "",
    "KEEP IDENTICAL:",
    "- Camera position, lens, perspective, and framing. Do not crop, zoom, or reframe.",
    "- Room size, ceiling height, and every wall.",
    ...openings.map((f) => `- ${f.kind.replace(/_/g, " ")} opening: ${f.description}`),
    "- Everything not listed under CHANGE, exactly as it appears in image 1.",
    "",
    "REALISM:",
    ...PRACTICAL_CONSTRAINTS.map((c) => `- ${c}`),
    "Render accurate material textures, shadows, and junctions. No people, text, markers, or watermarks.",
    ...(input.feedback ? ["", `A previous attempt failed verification. Fix this: ${input.feedback}`] : []),
  ].join("\n");
}

const PinChecks = z.object({
  pins: z.array(z.object({ pin: z.number().int().describe("Pin number, from 1"), result: z.enum(["done", "partial", "missed"]), note: z.string() })),
  markersDrawn: z.boolean().describe("True if the result shows red circles, numbers, or markers that were only meant as directions."),
});

/** Whether each pinned note was carried out, judged on the starting image and the result. */
async function checkPins(input: { model: string; before: Buffer; after: Buffer; pins: Pin[] }): Promise<z.infer<typeof PinChecks>> {
  return generateStructured({
    model: input.model,
    schema: PinChecks,
    images: [
      { bytes: input.before, mediaType: "image/png" },
      { bytes: input.after, mediaType: "image/png" },
    ],
    prompt: `Image 1 is a room before an edit, with numbered red markers showing where each change was asked for. Image 2 is the edited room. For each pinned note, say whether image 2 made that change at that spot: done, partial, or missed. Also say whether image 2 shows any red circle, number, or marker drawn into the room.

Pinned notes:
${input.pins.map(pinLine).join("\n")}`,
  });
}

async function readImage(runDir: string, relative: string): Promise<Buffer> {
  return readFile(path.join(runDir, relative));
}

/** The starting point for a change: the run's own result (v1) or a finished spot change. */
function startingPoint(photo: PhotoResult, tierResult: TierResult, versions: Version[], from: string) {
  if (from === ORIGINAL) return { id: ORIGINAL, plan: tierResult.plan, image: tierResult.image };
  const v = versions.find((x) => x.id === from);
  if (!v || v.status === "running" || !v.image) throw Object.assign(new Error(`Version ${from.slice(1)} has no image to start from. Pick another version.`), { status: 409 });
  return { id: v.id, plan: v.plan, image: v.image };
}

export type ChangeInput = {
  runDir: string;
  photoId: string;
  tier: Tier;
  from: string;
  request: Omit<ChangeRequest, "references">;
  /** Reference photos as uploaded (PNG/JPEG/WebP bytes). */
  references?: Buffer[];
  models: Models;
};

/** Validates the request, records a running version, and returns its id plus the work that fills it in. */
export async function startChange(input: ChangeInput): Promise<{ id: string; work: () => Promise<Version> }> {
  const { runDir, photoId, tier } = input;
  const photos = JSON.parse(await readFile(path.join(runDir, "results.json"), "utf8")) as PhotoResult[];
  const run = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")) as RunSummary;
  const photo = photos.find((p) => p.id === photoId);
  const tierResult = photo?.tiers.find((t) => t.tier === tier);
  if (!photo || !tierResult) throw Object.assign(new Error("That room and scope aren't in this report."), { status: 404 });
  const ask = input.request.ask.trim();
  const pins = input.request.pins.filter((p) => p.note.trim()).map((p) => ({ x: clamp(p.x), y: clamp(p.y), note: p.note.trim() }));
  if (!ask && pins.length === 0) throw Object.assign(new Error("Describe a change or pin a note on the image."), { status: 400 });

  const sharp = (await import("sharp")).default;
  const created = await updateVersions(runDir, async (file) => {
    const start = startingPoint(photo, tierResult, versionsFor(file, photoId, tier), input.from);
    const id = nextVersionId(file, photoId, tier);
    const dir = `${photoId}/${tier}/versions/${id}`;
    const references: string[] = [];
    for (const [i, bytes] of (input.references ?? []).slice(0, 3).entries()) {
      const name = `${dir}/refs/reference-${i + 1}.png`;
      await writeArtifact(runDir, name, await sharp(bytes).rotate().resize({ width: 1536, height: 1536, fit: "inside", withoutEnlargement: true }).png().toBuffer());
      references.push(name);
    }
    const request: ChangeRequest = { ask, notes: input.request.notes.trim(), pins: snapPins(pins, photo.inventory), references };
    const version: Version = {
      id, photoId, tier, parent: start.id, request, createdAt: new Date().toISOString(), status: "running",
      plan: start.plan, image: null, reasons: [], warnings: [], attempts: 0, editableShare: null, edges: [], judgement: null, apiCost: 0,
    };
    file.versions.push(version);
    await writeJson(runDir, `${dir}/request.json`, { parent: start.id, ...request });
    return { version, start, dir };
  });

  const work = async (): Promise<Version> => {
    const { version, start, dir } = created;
    let result: Partial<Version>;
    try {
      result = await runChange({ ...input, run, photo, version, start, dir });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`${photoId} ${tier} ${version.id}: error — ${message}`);
      result = { status: "error", reasons: [message] };
    }
    return updateVersions(runDir, (file) => {
      const entry = file.versions.find((v) => v.id === version.id && v.photoId === photoId && v.tier === tier);
      if (!entry) throw new Error("The version was deleted while it was being made.");
      Object.assign(entry, result);
      return entry;
    });
  };
  return { id: created.version.id, work };
}

const clamp = (n: number) => Math.max(0, Math.min(1000, Math.round(n)));

async function runChange(input: ChangeInput & {
  run: RunSummary;
  photo: PhotoResult;
  version: Version;
  start: { id: string; plan: ChangePlan; image: string | null };
  dir: string;
}): Promise<Partial<Version>> {
  const { runDir, photo, tier, models, version, start, dir, run } = input;
  const request = version.request;
  const label = `${photo.room ?? photo.inventory.roomType} ${TIER_LABELS[tier].name.toLowerCase()} ${version.id}`;
  progressAdd(5);

  // The taste only fills gaps the buyer left open, so a since-deleted profile doesn't block a change.
  const profile = await loadProfile(run.profile).catch(() => null);
  const listing = await readListing(listingDir(run.listing)).catch(() => null);
  const location = listing?.location ?? null;
  const original = await readImage(runDir, photo.original);
  const base = start.image && existsSync(path.join(runDir, start.image)) ? await readImage(runDir, start.image) : original;
  const marked = request.pins.length ? await markPins(base, request.pins) : null;
  if (marked) await writeArtifact(runDir, `${dir}/marked.png`, marked);
  const references = await Promise.all(request.references.map((r) => readImage(runDir, r)));
  const asInput = (bytes: Buffer): ImageInput => ({ bytes, mediaType: "image/png" });

  log(`${label}: revising the plan`);
  const prompt = revisePrompt({ inventory: photo.inventory, profile, plan: start.plan, tier, request, location });
  await writeArtifact(runDir, `${dir}/plan-prompt.txt`, prompt);
  const revised = await generateStructured({
    model: models.reasoning,
    schema: ChangePlan,
    prompt,
    images: [asInput(base), ...(marked ? [asInput(marked)] : []), ...references.map(asInput)],
  });
  const plan = priceChanges(enforceTier(revised, tier), location);
  await writeJson(runDir, `${dir}/plan.json`, plan);
  progressDone(1, `${label}: planned`);

  let feedback: string | undefined;
  let last: Partial<Version> = {};
  let attempts = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (isCancelled() && attempt > 1) break;
    if (attempt > 1) progressAdd(3);
    attempts = attempt;
    log(`${label}: redrawing${attempt > 1 ? ` (attempt ${attempt})` : ""}`);
    const editText = changePrompt({ inventory: photo.inventory, plan, previous: start.plan, request, marked: !!marked, feedback });
    await writeArtifact(runDir, `${dir}/prompt-${attempt}.txt`, editText);
    const redesign = await editImage({ model: run.imageModel ?? models.image, image: base, mask: null, prompt: editText, references: [...(marked ? [marked] : []), ...references] });
    const image = `${dir}/redesign-${attempt}.png`;
    await writeArtifact(runDir, image, redesign);
    progressDone(2, `${label}: redrawn`);

    log(`${label}: checking the structure${request.pins.length ? " and pins" : ""}`);
    const [edges, judgement, pinChecks] = await Promise.all([
      edgeChecks(original, redesign, photo.inventory),
      judge({ model: models.reasoning, original, redesign, inventory: photo.inventory, plan }),
      marked ? checkPins({ model: models.reasoning, before: marked, after: redesign, pins: request.pins }) : Promise.resolve(null),
    ]);
    const result = verdictWithPins(edges, judgement, pinChecks, request.pins);
    await writeJson(runDir, `${dir}/verify-${attempt}.json`, { ...result, edges, judgement, pinChecks });
    progressDone(1, `${label}: ${result.verdict}`);
    last = { status: result.verdict, reasons: result.reasons, image, edges, judgement, request: { ...request, pins: result.pins } };
    if (result.verdict !== "failed") break;
    feedback = result.reasons.join(" ");
  }

  return {
    ...last,
    plan,
    attempts,
    warnings: [],
    apiCost: Math.round((API_COST.plan + attempts * API_COST.attempt + (marked ? attempts * 0.02 : 0)) * 100) / 100,
  };
}

/** The usual structure verdict, plus pins: a missed pin or drawn-in markers make it Needs review. */
export function verdictWithPins(
  edges: Parameters<typeof verdict>[0],
  judgement: JudgeResult,
  checks: z.infer<typeof PinChecks> | null,
  pins: Pin[],
): { verdict: "verified" | "review" | "failed"; reasons: string[]; pins: Pin[] } {
  const base = verdict(edges, judgement);
  const marked = pins.map((pin, i) => {
    const check = checks?.pins.find((c) => c.pin === i + 1);
    return check ? { ...pin, result: check.result, resultNote: check.note } : pin;
  });
  const missed = marked.filter((p) => p.result === "missed" || p.result === "partial");
  const reasons = [
    ...base.reasons,
    ...missed.map((p) => `Pin ${marked.indexOf(p) + 1} (${p.item}) ${p.result === "missed" ? "wasn't done" : "was only partly done"}: ${p.resultNote ?? p.note}`),
    ...(checks?.markersDrawn ? ["Pin markers were drawn into the image."] : []),
  ];
  const verdictName = base.verdict === "failed" ? "failed" : reasons.length ? "review" : "verified";
  return { verdict: verdictName, reasons, pins: marked };
}

