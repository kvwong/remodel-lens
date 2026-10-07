import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, describe, expect, it, vi } from "vitest";

import { createLimiter } from "../src/files.js";

const gate = { active: 0, peak: 0 };

vi.mock("../src/listing/inventory.js", () => ({
  inventoryRoom: async () => ({ roomType: "kitchen", camera: "", fixed: [], changeable: [{ element: "flooring", current: "oak", minTier: "cosmetic", box: [0, 0, 1000, 1000] }], walls: [], condition: "", uncertainties: [] }),
}));
vi.mock("../src/redesign/plan.js", () => ({
  planRedesign: async ({ tier }: { tier: string }) => ({
    tier, expression: "", architecturalLanguage: "", removedWalls: [], preserve: [], feasibilityFlags: [], beyondScope: [], rationale: "",
    changes: [{ element: "flooring", current: "oak", proposed: "walnut", minTier: "cosmetic" }],
  }),
}));
vi.mock("../src/redesign/generate.js", () => ({
  editPrompt: () => "prompt",
  supportsMask: () => false,
  imageConcurrency: () => 6,
  editImage: async ({ image }: { image: Buffer }) => {
    gate.active += 1;
    gate.peak = Math.max(gate.peak, gate.active);
    await new Promise((r) => setTimeout(r, 20));
    gate.active -= 1;
    return image;
  },
}));
vi.mock("../src/redesign/verify.js", () => ({
  edgeChecks: async () => [],
  judge: async () => ({}),
  verdict: () => ({ verdict: "verified", reasons: [] }),
}));

const { redesignListing } = await import("../src/redesign/run.js");
const outDir = await mkdtemp(path.join(os.tmpdir(), "parallel-"));
afterAll(() => rm(outDir, { recursive: true, force: true }));

describe("redesign scheduling", () => {
  it("generates a photo's scopes side by side, in scope order", async () => {
    const bytes = await sharp({ create: { width: 32, height: 24, channels: 3, background: "#888" } }).png().toBuffer();
    const photos = ["a", "b"].map((id) => ({ id, basename: `${id}.png`, absolutePath: `/${id}.png`, bytes, mediaType: "image/png" }));
    const results = await redesignListing({
      photos,
      profile: { imagePromptSummary: "", globalAvoid: [], expressions: [], rooms: [] } as never,
      tiers: ["cosmetic", "moderate", "major"],
      models: { analysis: [], reasoning: "openai/x", image: "gpt-image-2.5" },
      outDir,
    });
    expect(gate.peak).toBe(6);
    const timing = JSON.parse(await readFile(path.join(outDir, "timings/a/major/generate-1.json"), "utf8"));
    expect(timing.status).toBe("success");
    expect(timing.durationMs).toBeGreaterThanOrEqual(0);
    expect(results.map((r) => r.tiers.map((t) => `${t.tier}:${t.status}`))).toEqual([
      ["cosmetic:verified", "moderate:verified", "major:verified"],
      ["cosmetic:verified", "moderate:verified", "major:verified"],
    ]);
  });

  it("lets a limiter's limit change between runs", async () => {
    let limit = 1;
    const run = createLimiter(() => limit);
    let active = 0;
    let peak = 0;
    const task = () => run(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
    });
    await Promise.all(Array.from({ length: 4 }, task));
    expect(peak).toBe(1);
    limit = 3;
    peak = 0;
    await Promise.all(Array.from({ length: 6 }, task));
    expect(peak).toBe(3);
  });
});
