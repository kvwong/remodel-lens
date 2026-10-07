import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { ChangePlan } from "../src/redesign/plan.js";
import type { PhotoResult } from "../src/redesign/run.js";

const prompts: Array<{ kind: string; prompt: string; images: number }> = [];

vi.mock("../src/providers.js", () => ({
  generateStructured: async ({ prompt, images }: { prompt: string; images?: unknown[] }) => {
    if (prompt.startsWith("You are revising")) {
      prompts.push({ kind: "revise", prompt, images: images?.length ?? 0 });
      return { ...basePlan, changes: [{ ...basePlan.changes[0]!, proposed: "brushed brass dome, smaller" }], rationale: "Smaller brass pendant." };
    }
    prompts.push({ kind: "pins", prompt, images: images?.length ?? 0 });
    return { pins: [{ pin: 1, result: "done", note: "Brass pendant shown." }], markersDrawn: false };
  },
}));
vi.mock("../src/redesign/generate.js", () => ({
  editImage: async ({ image, prompt, references }: { image: Buffer; prompt: string; references?: Buffer[] }) => {
    prompts.push({ kind: "edit", prompt, images: 1 + (references?.length ?? 0) });
    return image;
  },
}));
vi.mock("../src/redesign/verify.js", () => ({
  edgeChecks: async () => [],
  judge: async () => ({ fixedChecks: [], openingsChanged: false, cameraChanged: false, roomSizeChanged: false, planAdherence: 9, unplannedChanges: [], issues: [] }),
  verdict: () => ({ verdict: "verified", reasons: [] }),
}));
vi.mock("../src/redesign/job.js", () => ({ loadProfile: async () => ({ summary: "", era: "", palette: { walls: [], woodTones: [], metals: [], accents: [], contrast: "", saturation: "" }, categories: [], expressions: [], globalAvoid: [], roomNotes: [] }) }));
vi.mock("../src/listing/listing.js", () => ({ listingDir: (id: string) => id, readListing: async () => ({ location: "Bellevue, WA" }) }));

const { startChange } = await import("../src/redesign/change.js");
const { applyPicks, markPins, nextVersionId, readVersions, snapPins, updateVersions } = await import("../src/redesign/versions.js");
const { renderReport } = await import("../src/report.js");

const basePlan: ChangePlan = {
  tier: "cosmetic",
  expression: "",
  architecturalLanguage: "modern",
  changes: [{ element: "pendant over island", current: "brass globe", proposed: "black dome", minTier: "cosmetic", costItem: "other", quantity: 0, grade: "mid", costLow: 600, costHigh: 1100, costBasis: "2 fixtures", tasteRules: [], note: null }],
  removedWalls: [],
  preserve: [],
  feasibilityFlags: [],
  beyondScope: [],
  rationale: "",
};

const inventory = {
  roomType: "kitchen",
  camera: "",
  fixed: [{ kind: "window" as const, description: "window over sink", box: [400, 200, 600, 400] }],
  changeable: [
    { element: "pendant over island", current: "brass globe", minTier: "cosmetic" as const, box: [350, 0, 450, 200] },
    { element: "upper cabinets", current: "oak", minTier: "moderate" as const, box: [100, 150, 900, 450] },
  ],
  walls: [],
  condition: "",
  uncertainties: [],
};

const photo: PhotoResult = {
  id: "photo_01",
  basename: "kitchen.jpg",
  room: "Kitchen",
  original: "photo_01/original.png",
  inventory,
  tiers: [{ tier: "cosmetic", plan: basePlan, status: "verified", reasons: [], warnings: [], attempts: 1, editableShare: null, image: "photo_01/cosmetic/redesign-1.png", edges: [], judgement: null }],
};

let runDir: string;
beforeAll(async () => {
  runDir = await mkdtemp(path.join(os.tmpdir(), "changes-"));
  const png = await sharp({ create: { width: 60, height: 40, channels: 3, background: "#ccc" } }).png().toBuffer();
  const { writeArtifact, writeJson } = await import("../src/files.js");
  await writeArtifact(runDir, photo.original, png);
  await writeArtifact(runDir, photo.tiers[0]!.image!, png);
  await writeJson(runDir, "results.json", [photo]);
  await writeJson(runDir, "run.json", { id: "r", listing: "l", profile: "profiles/x/profile.json", tiers: ["cosmetic"], photos: [], startedAt: "2026-10-06T00:00:00Z", finishedAt: null, counts: {}, report: "report.html", error: null, imageModel: "gpt-image-2.5" });
});
afterAll(() => rm(runDir, { recursive: true, force: true }));

const models = { analysis: [], reasoning: "openai/x", image: "gpt-image-2.5" };

describe("pins", () => {
  it("snap to the smallest inventory box they land in, and flag fixed elements", () => {
    const [pendant, window, cabinets, nowhere] = snapPins(
      [{ x: 400, y: 100, note: "a" }, { x: 500, y: 300, note: "b" }, { x: 200, y: 300, note: "c" }, { x: 900, y: 900, note: "d" }],
      inventory,
    );
    expect(pendant).toMatchObject({ item: "pendant over island", fixed: false });
    expect(window).toMatchObject({ item: "window over sink", fixed: true });
    expect(cabinets).toMatchObject({ item: "upper cabinets", fixed: false });
    expect(nowhere).toMatchObject({ item: "lower right of the image", fixed: false });
  });

  it("draw numbered markers without changing the image size", async () => {
    const png = await sharp({ create: { width: 200, height: 100, channels: 3, background: "#fff" } }).png().toBuffer();
    const marked = await markPins(png, [{ x: 500, y: 500, note: "x" }]);
    expect(await sharp(marked).metadata()).toMatchObject({ width: 200, height: 100 });
    const { data } = await sharp(marked).extract({ left: 90, top: 50, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
    expect([...data].slice(0, 3)).not.toEqual([255, 255, 255]);
  });
});

describe("versions.json", () => {
  it("keeps every entry when changes finish at the same time", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "versions-"));
    await Promise.all(["a", "b", "c"].map((id) => updateVersions(dir, async (file) => {
      await new Promise((r) => setTimeout(r, 5));
      file.versions.push({ id } as never);
    })));
    expect((await readVersions(dir)).versions.map((v) => v.id).sort()).toEqual(["a", "b", "c"]);
    await rm(dir, { recursive: true, force: true });
  });

  it("numbers versions per photo and scope, after the original", () => {
    const file = { versions: [{ id: "v2", photoId: "p", tier: "cosmetic" }, { id: "v3", photoId: "p", tier: "cosmetic" }, { id: "v2", photoId: "p", tier: "moderate" }] as never, picks: {} };
    expect(nextVersionId(file, "p", "cosmetic")).toBe("v4");
    expect(nextVersionId(file, "p", "major")).toBe("v2");
  });
});

describe("a spot change", () => {
  it("re-plans and redraws from the version on screen, then records the result", async () => {
    const { id, work } = await startChange({ runDir, photoId: "photo_01", tier: "cosmetic", from: "v1", request: { ask: "", notes: "Keep the island", pins: [{ x: 400, y: 100, note: "Smaller brass pendant" }] }, models });
    expect(id).toBe("v2");
    expect((await readVersions(runDir)).versions[0]).toMatchObject({ id: "v2", status: "running", parent: "v1" });

    const v = await work();
    expect(v).toMatchObject({ id: "v2", status: "verified", image: "photo_01/cosmetic/versions/v2/redesign-1.png", attempts: 1 });
    expect(v.plan.changes[0]!.proposed).toBe("brushed brass dome, smaller");
    expect(v.request.pins[0]).toMatchObject({ item: "pendant over island", result: "done" });
    expect(v.apiCost).toBeGreaterThan(0);

    const edit = prompts.find((p) => p.kind === "edit")!;
    expect(edit.prompt).toContain("At pendant over island (marker 1");
    expect(edit.prompt).toContain("never draw circles");
    expect(edit.images).toBe(2); // the image being edited plus the marked-up copy
    expect(prompts.find((p) => p.kind === "revise")!.prompt).toContain("Context from the buyer: Keep the island");
    expect(JSON.parse(await readFile(path.join(runDir, "photo_01/cosmetic/versions/v2/request.json"), "utf8"))).toMatchObject({ parent: "v1" });
  });

  it("starts the next change from a finished version and refuses an empty ask", async () => {
    const { id, work } = await startChange({ runDir, photoId: "photo_01", tier: "cosmetic", from: "v2", request: { ask: "Warmer wall paint", notes: "", pins: [] }, models });
    expect(id).toBe("v3");
    expect((await work()).parent).toBe("v2");
    await expect(startChange({ runDir, photoId: "photo_01", tier: "cosmetic", from: "v2", request: { ask: " ", notes: "", pins: [{ x: 1, y: 1, note: "" }] }, models })).rejects.toThrow(/Describe a change/);
    await expect(startChange({ runDir, photoId: "photo_01", tier: "moderate", from: "v1", request: { ask: "x", notes: "", pins: [] }, models })).rejects.toThrow(/aren't in this report/);
  });

  it("shows the picked version in the report, totals, and composer", async () => {
    const file = await readVersions(runDir);
    file.picks["photo_01:cosmetic"] = "v2";
    const photos = applyPicks([photo], file);
    expect(photos[0]!.tiers[0]!.image).toBe("photo_01/cosmetic/versions/v2/redesign-1.png");

    const html = renderReport({ title: "12 Maple St", photos, profileSummary: "", changes: { api: "/api/runs/l/r", originals: [photo], versions: file } });
    expect(html).toContain('data-picked="v2"');
    expect(html).toContain("Version 3");
    expect(html).toContain('class="composer"');
    expect(html).toContain("Your change");
    expect(html).toContain("3 versions of the Cosmetic kitchen");
    expect(html).toContain("2 changes");

    const plain = renderReport({ title: "12 Maple St", photos: [photo], profileSummary: "" });
    expect(plain).not.toContain('class="composer"');
    expect(plain).not.toContain("CHANGES_API");
  });
});
