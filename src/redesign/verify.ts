import sharp from "sharp";
import { z } from "zod";

import { decide, type DecisionQuestion } from "../decisions.js";
import type { BoxTuple, RoomInventory } from "../listing/inventory.js";
import { log } from "../files.js";
import { generateStructured } from "../providers.js";
import { TIER_DEFINITIONS } from "./tiers.js";
import type { ChangePlan } from "./plan.js";

const EDGE_WIDTH = 384; // small enough to forgive a few pixels of drift
export const EDGE_THRESHOLD = 0.45;

/** Minimum edge correlation for a fixed element to count as preserved. Override with EDGE_THRESHOLD; tune with `npm run tune`. */
export function edgeThreshold(): number {
  const value = Number(process.env.EDGE_THRESHOLD);
  return value > 0 && value < 1 ? value : EDGE_THRESHOLD;
}

type Gray = { data: Float32Array; width: number; height: number };

async function edgeMap(bytes: Uint8Array, width: number, height: number): Promise<Gray> {
  const { data } = await sharp(bytes)
    .resize({ width, height, fit: "fill" })
    .greyscale()
    .blur(1)
    .raw()
    .toBuffer({ resolveWithObject: true });
  return sobel({ data: Float32Array.from(data), width, height });
}

export function sobel(img: Gray): Gray {
  const { data, width, height } = img;
  const out = new Float32Array(width * height);
  const at = (x: number, y: number) => data[y * width + x]!;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const gx = -at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1) + at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1);
      const gy = -at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1) + at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1);
      out[y * width + x] = Math.hypot(gx, gy);
    }
  }
  return { data: out, width, height };
}

/** Pearson correlation of edge magnitude inside a box. null when the original region is too flat to judge. */
export function boxCorrelation(a: Gray, b: Gray, box: BoxTuple): number | null {
  const x0 = Math.floor((box[0] / 1000) * a.width);
  const y0 = Math.floor((box[1] / 1000) * a.height);
  const x1 = Math.ceil((box[2] / 1000) * a.width);
  const y1 = Math.ceil((box[3] / 1000) * a.height);
  const xs: number[] = [];
  const ys: number[] = [];
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      xs.push(a.data[y * a.width + x]!);
      ys.push(b.data[y * b.width + x]!);
    }
  }
  if (xs.length < 50) return null;
  const mean = (v: number[]) => v.reduce((s, n) => s + n, 0) / v.length;
  const [mx, my] = [mean(xs), mean(ys)];
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < xs.length; i += 1) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  if (Math.sqrt(vx / xs.length) < 8) return null; // flat region in the original: nothing structural to compare
  if (vy === 0) return 0;
  return cov / Math.sqrt(vx * vy);
}

export type EdgeCheck = { kind: string; description: string; correlation: number | null; pass: boolean };

/**
 * Shrink an opening's box to its glass/view area. Frames and trim live at the edges and may legitimately
 * change; the view through the opening only shifts if the opening itself moves or resizes.
 */
export function insetBox(box: BoxTuple, fraction = 0.2): BoxTuple {
  const dx = (box[2] - box[0]) * fraction;
  const dy = (box[3] - box[1]) * fraction;
  return [box[0] + dx, box[1] + dy, box[2] - dx, box[3] - dy];
}

const OPENING_KINDS = new Set(["window", "exterior_door", "skylight", "doorway_opening", "interior_door"]);

export async function edgeChecks(original: Uint8Array, redesign: Uint8Array, inventory: RoomInventory, threshold = edgeThreshold()): Promise<EdgeCheck[]> {
  const meta = await sharp(original).metadata();
  const height = Math.round(EDGE_WIDTH * ((meta.height ?? 1) / (meta.width ?? 1)));
  const [a, b] = await Promise.all([edgeMap(original, EDGE_WIDTH, height), edgeMap(redesign, EDGE_WIDTH, height)]);
  return inventory.fixed
    .filter((item) => ["window", "exterior_door", "skylight", "stair", "doorway_opening", "interior_door", "beam", "column", "fireplace"].includes(item.kind))
    .map((item) => {
      const box = OPENING_KINDS.has(item.kind) ? insetBox(item.box as BoxTuple) : (item.box as BoxTuple);
      const correlation = boxCorrelation(a, b, box);
      return { kind: item.kind, description: item.description, correlation, pass: correlation === null || correlation >= threshold };
    });
}

export const JudgeResult = z.object({
  fixedChecks: z.array(z.object({ element: z.string(), preserved: z.boolean(), note: z.string() })),
  openingsChanged: z.boolean().describe("Any window, door, or doorway opening added, removed, merged, moved, or resized by its wall edges (beyond planned wall removals). More visible glass from slimmer frames is not a change."),
  cameraChanged: z.boolean().describe("Viewpoint, crop, or perspective noticeably different."),
  roomSizeChanged: z.boolean().describe("Room is visibly larger or smaller, or the ceiling height changed. Removing planned decorative coffers or soffits does not count."),
  planAdherence: z.number().int().describe("0–10: did the planned changes happen as described?"),
  scopeExceeded: z.boolean().describe("True when visible changes exceed the allowed remodel scope. Explain the offending changes in issues and unplannedChanges."),
  unplannedChanges: z.array(z.string()),
  issues: z.array(z.string()),
});
export type JudgeResult = z.infer<typeof JudgeResult>;

type JudgeInput = { model: string; original: Uint8Array; redesign: Uint8Array; inventory: RoomInventory; plan: ChangePlan };

/** A clear pass needs every structural answer at least this sure; anything less goes to the full judge. */
export const QUICK_PASS = 0.85;
const QUICK_WIDTH = 1024;

/** The Decisions API's yes/no read on the judge's structural questions, or null when it isn't a clear pass. */
export async function quickJudge(input: JudgeInput, fetchFn: typeof fetch = fetch): Promise<JudgeResult | null> {
  const small = (bytes: Uint8Array) => sharp(bytes).resize({ width: QUICK_WIDTH, withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
  const [original, redesign] = await Promise.all([small(input.original), small(input.redesign)]);
  const fixed = input.inventory.fixed;
  const questions: DecisionQuestion[] = [
    ...fixed.map((item, i): DecisionQuestion => ({ type: "predicate", name: `preserved_${i}`, instructions: `Is this fixed element from image 1 still in image 2 in the same position, size and count: ${item.kind}, ${item.description}? Judge windows and doors by the opening's wall edges; new frames, casings or trim inside the same opening still count as preserved.` })),
    { type: "predicate", name: "openings_changed", instructions: JudgeResult.shape.openingsChanged.description! },
    { type: "predicate", name: "camera_changed", instructions: JudgeResult.shape.cameraChanged.description! },
    { type: "predicate", name: "room_size_changed", instructions: JudgeResult.shape.roomSizeChanged.description! },
    { type: "predicate", name: "scope_compliant", instructions: `Are all visible changes in image 2 within this allowed scope: ${TIER_DEFINITIONS[input.plan.tier].allowed}? Compare against image 1. Judge visible construction changes; do not infer hidden work. A planned change still fails if it exceeds the scope.` },
    { type: "score", name: "plan_adherence", instructions: "How fully did the planned changes happen in image 2?", levels: [
      { label: "none", description: "None of the planned changes are visible." },
      { label: "little", description: "A few planned changes, most missing." },
      { label: "half", description: "About half of the planned changes." },
      { label: "most", description: "Most planned changes, a few missing or different." },
      { label: "all", description: "The planned changes happened as described." },
    ] },
  ];
  const answers = await decide({
    text: `Image 1 is a listing photo. Image 2 is meant to be a realistic remodel of the same room from the same camera. Any change to the architecture is a failure; small rendering differences a builder wouldn't notice are not.
Allowed scope: ${TIER_DEFINITIONS[input.plan.tier].allowed}. Flag any visible change outside this scope even when it is in the plan.
Planned changes (tier ${input.plan.tier}):
${input.plan.changes.map((c) => `- ${c.element}: → ${c.proposed}`).join("\n")}
${input.plan.removedWalls.length ? `Planned wall removals: ${input.plan.removedWalls.join("; ")}` : "No walls are planned for removal."}`,
    images: [{ bytes: original, mediaType: "image/jpeg" }, { bytes: redesign, mediaType: "image/jpeg" }],
    questions,
  }, fetchFn);
  const yes = (name: string) => { const a = answers.get(name); return a?.type === "predicate" ? a.probability : null; };
  const kept = fixed.map((_, i) => yes(`preserved_${i}`));
  const changed = ["openings_changed", "camera_changed", "room_size_changed"].map(yes);
  const score = answers.get("plan_adherence");
  if (kept.some((p) => p === null || p < QUICK_PASS) || changed.some((p) => p === null || p > 1 - QUICK_PASS) || (yes("scope_compliant") ?? 0) < QUICK_PASS || score?.type !== "score") return null;
  return {
    fixedChecks: fixed.map((item) => ({ element: `${item.kind}: ${item.description}`, preserved: true, note: "" })),
    openingsChanged: false,
    cameraChanged: false,
    roomSizeChanged: false,
    planAdherence: Math.round(Math.max(0, Math.min(4, score.score)) * 2.5), // five levels (0–4) onto the judge's 0–10
    scopeExceeded: false,
    unplannedChanges: [],
    issues: [],
  };
}

/**
 * Structural check of a redesign. Unless QUICK_JUDGE=off, the Decisions API answers first; a clear pass is final, and
 * anything doubtful or failed goes to the full vision judge, whose notes feed the retry prompt and the report.
 */
export async function judge(input: JudgeInput, deps: { fetch?: typeof fetch; full?: typeof fullJudge } = {}): Promise<JudgeResult> {
  if (process.env.QUICK_JUDGE !== "off" && process.env.OPENAI_API_KEY) {
    try {
      const quick = await quickJudge(input, deps.fetch);
      if (quick) return quick;
    } catch (error) {
      log(`Quick check unavailable (${error instanceof Error ? error.message : String(error)}); using the full judge`);
    }
  }
  return (deps.full ?? fullJudge)(input);
}

export async function fullJudge(input: JudgeInput): Promise<JudgeResult> {
  return generateStructured({
    model: input.model,
    schema: JudgeResult,
    images: [
      { bytes: input.original, mediaType: "image/png" },
      { bytes: input.redesign, mediaType: "image/png" },
    ],
    prompt: `Image 1 is a listing photo. Image 2 is meant to be a realistic remodel of the same room from the same camera. Be strict: the buyer will use this to decide whether the remodel is feasible, so any change to the architecture is a failure.

Check every fixed element below and report whether it is preserved in the same position, size, and count.

How to judge:
- For windows and doors, judge the OPENING by its wall edges: head height, jamb positions, sill line, and how many separate units there are. Slimmer replacement frames naturally show more glass inside the same opening, and removed casing becomes wall surface; neither is a change to the opening. New frames, sashes, casings, or trim are allowed when they appear in the planned changes.
- A failure is a difference that would require construction to build: an opening moved, resized, added, removed, or merged with another; a ceiling raised, lowered, or reshaped (beyond planned removal of decorative coffers or soffits, which exposes the ceiling at its existing height); a firebox resized; the room visibly larger or smaller.
- Ignore small rendering differences that a builder would not notice or could not build differently (a few percent of a dimension, slight perspective softness). Mention them in issues, but mark the element preserved.
- Adding or removing planned decorative coffers, beams, or trim is not a change to the ceiling or openings.
Fixed elements:
${input.inventory.fixed.map((item) => `- ${item.kind}: ${item.description}`).join("\n")}

Allowed scope: ${TIER_DEFINITIONS[input.plan.tier].allowed}. Flag any visible change outside this scope even when it is in the plan.
Planned changes (tier ${input.plan.tier}):
${input.plan.changes.map((c) => `- ${c.element}: → ${c.proposed}`).join("\n")}
${input.plan.removedWalls.length ? `Planned wall removals: ${input.plan.removedWalls.join("; ")}` : "No walls are planned for removal."}`,
  });
}

export type Verdict = "verified" | "review" | "failed";

export function verdict(edges: EdgeCheck[], judgement: JudgeResult): { verdict: Verdict; reasons: string[] } {
  const reasons = [
    ...judgement.fixedChecks.filter((c) => !c.preserved).map((c) => `${c.element} not preserved: ${c.note}`),
    ...(judgement.scopeExceeded ? ["Changes exceed the selected remodel scope.", ...judgement.unplannedChanges] : []),
    ...(judgement.openingsChanged ? ["Openings were added, removed, or moved."] : []),
    ...(judgement.cameraChanged ? ["Camera viewpoint changed."] : []),
    ...(judgement.roomSizeChanged ? ["Room size or ceiling height changed."] : []),
  ];
  if (reasons.length > 0) return { verdict: "failed", reasons };
  const edgeFailures = edges.filter((e) => !e.pass);
  if (edgeFailures.length > 0 || judgement.planAdherence < 6) {
    return {
      verdict: "review",
      reasons: [
        ...edgeFailures.map((e) => `Edge structure shifted around ${e.kind} (${e.description}), r=${e.correlation?.toFixed(2)}`),
        ...(judgement.planAdherence < 6 ? [`Plan only partly followed (${judgement.planAdherence}/10).`] : []),
      ],
    };
  }
  return { verdict: "verified", reasons: [] };
}
