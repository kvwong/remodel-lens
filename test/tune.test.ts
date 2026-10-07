import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import type { RoomInventory } from "../src/listing/inventory.js";
import type { JudgeResult } from "../src/redesign/verify.js";
import { splitEffort } from "../src/providers.js";
import { modelStats, renderTuningReport, suggestThreshold, sweep, type AttemptRecord } from "../src/tune/analyze.js";
import { collectAttempts, readLabels, writeLabelTemplate } from "../src/tune/collect.js";

const record = (correlation: number | null, overrides: Partial<AttemptRecord> = {}): AttemptRecord => ({
  key: `l/r/p/cosmetic/${Math.random()}`,
  listing: "l",
  run: "r",
  photo: "p",
  tier: "cosmetic",
  attempt: 1,
  imageModel: "model-a",
  verdict: "verified",
  final: true,
  edges: [{ kind: "window", correlation }],
  judgeBroken: false,
  planAdherence: 8,
  label: null,
  original: "",
  redesign: "",
  ...overrides,
});

describe("threshold sweep", () => {
  it("counts edge flags against labels, falling back to the judge", () => {
    const records = [
      record(0.2, { label: "broken" }),
      record(0.35, { judgeBroken: true }),
      record(0.4, { label: "ok", judgeBroken: true }), // your label wins over the judge
      record(0.8),
      record(null), // flat region: never flagged
    ];
    const [low, mid] = sweep(records, [0.3, 0.45]);
    expect(low).toMatchObject({ tp: 1, fp: 0, fn: 1, tn: 3 });
    expect(mid).toMatchObject({ tp: 2, fp: 1, fn: 0, tn: 2 });
    expect(suggestThreshold([low!, mid!])?.threshold).toBe(0.45);
  });

  it("suggests nothing without broken examples", () => {
    expect(suggestThreshold(sweep([record(0.9), record(0.2)], [0.3, 0.5]))).toBeNull();
  });
});

describe("model stats", () => {
  it("scores the kept attempt per tier and counts retries", () => {
    const stats = modelStats([
      record(0.9, { imageModel: "a", attempt: 1, final: true, verdict: "verified" }),
      record(0.1, { imageModel: "b", attempt: 1, final: false, verdict: "failed", judgeBroken: true }),
      record(0.6, { imageModel: "b", attempt: 2, final: true, verdict: "review" }),
    ]);
    expect(stats).toEqual([
      expect.objectContaining({ imageModel: "a", tiers: 1, verified: 1, firstTry: 1, meanAttempts: 1, brokenRate: 0 }),
      expect.objectContaining({ imageModel: "b", tiers: 1, review: 1, firstTry: 0, meanAttempts: 2, brokenRate: 0.5 }),
    ]);
  });

  it("splits runs by planner and reports their median run time", () => {
    const stats = modelStats([
      record(0.9, { imageModel: "a", run: "r1", runMinutes: 8, final: true, verdict: "verified" }),
      record(0.9, { imageModel: "a", run: "r2", planner: "fast", runMinutes: 5, final: true, verdict: "verified" }),
    ]);
    expect(stats).toEqual([
      expect.objectContaining({ imageModel: "a", planner: null, medianRunMinutes: 8 }),
      expect.objectContaining({ imageModel: "a", planner: "fast", medianRunMinutes: 5 }),
    ]);
  });

  it("renders a report even with no runs", () => {
    expect(renderTuningReport([], 0.45)).toContain("No verified attempts found");
    expect(renderTuningReport([record(0.2, { label: "broken" }), record(0.9)], 0.45)).toContain("| 0.45 (current)");
  });
});

let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

const inventory: RoomInventory = {
  roomType: "living",
  camera: "",
  fixed: [{ kind: "window", description: "picture window", box: [200, 200, 800, 800] }],
  changeable: [],
  walls: [],
  condition: "",
  uncertainties: [],
};
const judgement: JudgeResult = { fixedChecks: [], openingsChanged: false, cameraChanged: false, roomSizeChanged: false, planAdherence: 7, unplannedChanges: [], issues: [] };

/** Vertical stripes; shifting them moves every edge. */
async function stripes(offset: number) {
  const width = 200;
  const data = Buffer.alloc(width * width * 3);
  for (let y = 0; y < width; y += 1) for (let x = 0; x < width; x += 1) data.fill(Math.floor((x + offset) / 20) % 2 ? 255 : 0, (y * width + x) * 3, (y * width + x) * 3 + 3);
  return sharp(data, { raw: { width, height: width, channels: 3 } }).png().toBuffer();
}

describe("collecting past runs", () => {
  it("re-scores saved images, tags the image model, and keeps filled-in labels", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "tune-"));
    const tierDir = path.join(dir, "house", "run1", "photo-1", "moderate");
    await mkdir(tierDir, { recursive: true });
    await writeFile(path.join(dir, "house", "run1", "run.json"), JSON.stringify({ imageModel: "gpt-image-2" }));
    await writeFile(path.join(dir, "house", "run1", "photo-1", "inventory.json"), JSON.stringify(inventory));
    await writeFile(path.join(dir, "house", "run1", "photo-1", "original.png"), await stripes(0));
    await writeFile(path.join(tierDir, "redesign-1.png"), await stripes(10));
    await writeFile(path.join(tierDir, "verify-1.json"), JSON.stringify({ verdict: "failed", edges: [], judgement: { ...judgement, openingsChanged: true } }));
    await writeFile(path.join(tierDir, "redesign-2.png"), await stripes(0));
    await writeFile(path.join(tierDir, "verify-2.json"), JSON.stringify({ verdict: "verified", edges: [], judgement }));

    const records = await collectAttempts(dir);
    expect(records.map((r) => [r.key, r.imageModel, r.final, r.judgeBroken])).toEqual([
      ["house/run1/photo-1/moderate/1", "gpt-image-2", false, true],
      ["house/run1/photo-1/moderate/2", "gpt-image-2", true, false],
    ]);
    expect(records[0]!.edges[0]!.correlation!).toBeLessThan(0);
    expect(records[1]!.edges[0]!.correlation!).toBeCloseTo(1, 5);

    const labels = path.join(dir, "labels.json");
    expect(await writeLabelTemplate(labels, records)).toEqual({ added: 2, total: 2 });
    const filled = JSON.parse(await readFile(labels, "utf8"));
    filled["house/run1/photo-1/moderate/2"].label = "broken";
    await writeFile(labels, JSON.stringify(filled));
    expect(await writeLabelTemplate(labels, records)).toEqual({ added: 0, total: 2 });
    expect(await readLabels(labels)).toEqual({ "house/run1/photo-1/moderate/1": null, "house/run1/photo-1/moderate/2": "broken" });
    expect((await collectAttempts(dir, { labels: await readLabels(labels), only: new Set(["house/run1"]) }))[1]!.label).toBe("broken");
    expect(await collectAttempts(dir, { only: new Set(["other/run"]) })).toEqual([]);
  });
});

describe("model effort suffix", () => {
  it("reads :low/:medium/:high off a model id", () => {
    expect(splitEffort("openai/gpt-6.1-sol:low")).toEqual({ model: "openai/gpt-6.1-sol", effort: "low" });
    expect(splitEffort("anthropic/claude-sonnet-5-5")).toEqual({ model: "anthropic/claude-sonnet-5-5", effort: "medium" });
  });
});

describe("reasoning effort default", () => {
  it("runs the reasoning model at low effort unless its id names one", async () => {
    const { atLowEffort } = await import("../src/config.js");
    expect(atLowEffort("openai/gpt-6.1-sol")).toBe("openai/gpt-6.1-sol:low");
    expect(atLowEffort("openai/gpt-6.1-sol:high")).toBe("openai/gpt-6.1-sol:high");
  });
});
