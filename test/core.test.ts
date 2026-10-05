import { readFileSync } from "node:fs";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { createLimiter, log, logContext } from "../src/files.js";
import { normalizeBox, normalizeInventoryBoxes, type RoomInventory } from "../src/listing/inventory.js";
import { buildMask, editableBoxes, editableShare, protectedBoxes } from "../src/redesign/mask.js";
import { enforceTier, type ChangePlan } from "../src/redesign/plan.js";
import { parseTiers } from "../src/redesign/tiers.js";
import { edgeChecks, verdict, type JudgeResult } from "../src/redesign/verify.js";
import { formatRange, formatUSD, listingTotals, renderReport } from "../src/report.js";
import { editPrompt, supportsMask } from "../src/redesign/generate.js";
import { planCost, roomNotesFor } from "../src/redesign/plan.js";
import { isStrongRule } from "../src/taste/pipeline.js";
import { chunkPrompt } from "../src/taste/prompts.js";
import { TasteProfile, type TasteProfile as TasteProfileType } from "../src/taste/schema.js";

const inventory: RoomInventory = {
  roomType: "kitchen",
  camera: "wide, eye level",
  fixed: [
    { kind: "window", description: "double-hung over sink", box: [400, 150, 600, 450] },
    { kind: "ceiling_line", description: "flat ceiling", box: [0, 0, 1000, 80] },
    { kind: "plumbing_location", description: "sink", box: [420, 500, 580, 600] },
  ],
  changeable: [
    { element: "upper cabinets", current: "oak raised panel", minTier: "moderate", box: [100, 100, 900, 400] },
    { element: "wall paint", current: "beige", minTier: "cosmetic", box: [0, 0, 1000, 700] },
  ],
  walls: [{ description: "wall between kitchen and dining", exterior: false, possiblyLoadBearing: true, box: [800, 0, 1000, 1000] }],
  condition: "dated",
  uncertainties: [],
};

const plan = (changes: Partial<ChangePlan["changes"][number]>[], tier: ChangePlan["tier"] = "moderate"): ChangePlan => ({
  tier,
  expression: "",
  architecturalLanguage: "traditional",
  beyondScope: [],
  changes: changes.map((c) => ({ element: "x", current: "", proposed: "", minTier: "cosmetic", costItem: "other", quantity: 0, grade: "mid", costLow: 1000, costHigh: 2000, costBasis: "", tasteRules: [], note: null, ...c })),
  removedWalls: ["wall between kitchen and dining"],
  preserve: [],
  feasibilityFlags: [],
  rationale: "",
});

describe("boxes", () => {
  it("clamps, orders, and rejects degenerate boxes", () => {
    expect(normalizeBox([900, 1200, 100, -5])).toEqual([100, 0, 900, 1000]);
    expect(normalizeBox([10, 10, 12, 500])).toBeNull();
    expect(normalizeBox([1, 2, 3])).toBeNull();
    expect(normalizeInventoryBoxes({ ...inventory, fixed: [{ kind: "window", description: "", box: [0, 0, 1, 1] }] }).fixed).toEqual([]);
  });
});

describe("tiers", () => {
  it("drops changes above the tier and moves them to preserve", () => {
    const result = enforceTier(plan([{ element: "upper cabinets", minTier: "moderate" }, { element: "wall paint" }]), "cosmetic");
    expect(result.changes.map((c) => c.element)).toEqual(["wall paint"]);
    expect(result.preserve).toContain("upper cabinets");
    expect(result.removedWalls).toEqual([]);
  });

  it("only allows wall removal at major", () => {
    expect(enforceTier(plan([], "major"), "major").removedWalls).toHaveLength(1);
  });

  it("parses tiers and rejects unknown ones", () => {
    expect(parseTiers(undefined)).toEqual(["cosmetic", "moderate"]);
    expect(() => parseTiers("cosmetic,gutted")).toThrow(/gutted/);
  });
});

describe("mask", () => {
  it("opens planned items, keeps windows protected, and leaves plumbing to the prompt", async () => {
    const editable = editableBoxes(inventory, enforceTier(plan([{ element: "Upper Cabinets", minTier: "moderate" }]), "moderate"));
    expect(editable).toEqual([[100, 100, 900, 400]]);

    const { hard, soft } = protectedBoxes(inventory, "moderate");
    expect(hard).toEqual([[400, 150, 600, 450]]);
    expect(soft).toEqual([[0, 0, 1000, 80]]);

    const mask = await buildMask({ width: 100, height: 100, editable, hard, soft, pad: 0 });
    const { data } = await sharp(mask).extractChannel(3).raw().toBuffer({ resolveWithObject: true });
    const alpha = (x: number, y: number) => data[y * 100 + x];
    expect(alpha(20, 30)).toBe(0); // cabinet: editable
    expect(alpha(50, 30)).toBe(255); // window inside cabinet box: protected wins
    expect(alpha(20, 80)).toBe(255); // untouched floor
    expect(alpha(20, 12)).toBe(0); // ceiling band overlaps a planned change, so it stays open
    expect(await editableShare(mask)).toBeGreaterThan(0.1);
  });
});

/** Synthetic room: flat wall with a framed window at a given x offset. */
async function room(windowX: number, trim = { color: "#fff", width: 10 }): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600">
    <rect width="800" height="600" fill="#d8d2c4"/>
    <rect x="${windowX}" y="100" width="160" height="200" fill="#9ec3e6" stroke="${trim.color}" stroke-width="${trim.width}"/>
    <line x1="${windowX + 80}" y1="100" x2="${windowX + 80}" y2="300" stroke="#fff" stroke-width="6"/>
    <rect y="450" width="800" height="150" fill="#7a5c3e"/>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

describe("geometry verification", () => {
  const windowInventory: RoomInventory = {
    ...inventory,
    fixed: [{ kind: "window", description: "center window", box: [380, 150, 620, 520] }],
  };

  it("passes when the window stays put, even if the wall color changes", async () => {
    const original = await room(320);
    const repainted = await sharp(original).modulate({ hue: 40, saturation: 1.4 }).png().toBuffer();
    const [check] = await edgeChecks(original, repainted, windowInventory);
    expect(check!.pass).toBe(true);
    expect(check!.correlation!).toBeGreaterThan(0.8);
  });

  it("passes when only the window's trim and frame change (heavy white casing → slim black frame)", async () => {
    const [check] = await edgeChecks(await room(320), await room(320, { color: "#1b1b1b", width: 4 }), windowInventory);
    expect(check!.pass).toBe(true);
  });

  it("fails when the window moves", async () => {
    const [check] = await edgeChecks(await room(320), await room(520), windowInventory);
    expect(check!.pass).toBe(false);
  });

  it("judge failures outrank edge passes; edge-only failures become review", () => {
    const judgement: JudgeResult = { fixedChecks: [], openingsChanged: false, cameraChanged: false, roomSizeChanged: false, planAdherence: 8, unplannedChanges: [], issues: [] };
    const okEdge = { kind: "window", description: "", correlation: 0.9, pass: true };
    const badEdge = { ...okEdge, correlation: 0.1, pass: false };
    expect(verdict([okEdge], judgement).verdict).toBe("verified");
    expect(verdict([badEdge], judgement).verdict).toBe("review");
    expect(verdict([okEdge], { ...judgement, openingsChanged: true }).verdict).toBe("failed");
  });
});

describe("taste + report", () => {
  it("treats single-photo rules as weak", () => {
    const rule = (support: number, fromBrief = false) => ({ rule: "", support, fromBrief });
    expect(isStrongRule(rule(1), 15)).toBe(false);
    expect(isStrongRule(rule(4), 15)).toBe(true);
    expect(isStrongRule(rule(2), 4)).toBe(true);
    expect(isStrongRule(rule(0, true), 13)).toBe(true); // owner's brief outranks image counts
  });

  it("escapes model text in the report", () => {
    const html = renderReport({
      title: "123 Main <St>",
      profileSummary: "x",
      photos: [{ id: "photo_01", basename: "a.jpg", original: "photo_01/original.png", inventory, tiers: [] }],
    });
    expect(html).toContain("123 Main &lt;St&gt;");
    expect(html).not.toContain("<St>");
  });
});

describe("brief + room direction", () => {
  const fixture = (() => {
    const raw = JSON.parse(readFileSync(new URL("./fixtures/profile.json", import.meta.url), "utf8"));
    return { ...TasteProfile.parse(raw), imageCount: raw.imageCount } as TasteProfileType;
  })();

  it("fixture profile is schema-valid and covers the three target rooms", () => {
    expect(fixture.roomNotes.map((r) => r.room)).toEqual(expect.arrayContaining(["kitchen", "living room", "home office"]));
  });

  it("matches free-text room types to room notes", () => {
    expect(roomNotesFor(fixture, "Open kitchen with breakfast nook").map((r) => r.room)).toEqual(["kitchen"]);
    expect(roomNotesFor(fixture, "family room").map((r) => r.room)).toEqual(["living room"]);
    expect(roomNotesFor(fixture, "family / media room").map((r) => r.room)).toEqual(["living room"]);
    expect(roomNotesFor(fixture, "Study / den").map((r) => r.room).sort()).toEqual(["home office", "living room"]);
    expect(roomNotesFor(fixture, "garage")).toEqual([]);
  });

  it("puts room direction and realism constraints into the edit prompt", () => {
    const prompt = editPrompt({ inventory, plan: plan([{ element: "upper cabinets", proposed: "rift oak slab" }]), profile: fixture });
    expect(prompt).toContain("KITCHEN DIRECTION:");
    expect(prompt).toContain("coffee station");
    expect(prompt).toContain("door swings");
    expect(prompt).not.toContain("HOME OFFICE DIRECTION:");
  });

  it("injects the brief into rule extraction only when provided", () => {
    expect(chunkPrompt("chunk_01", [], "Use oak.")).toContain("<owner-brief>");
    expect(chunkPrompt("chunk_01", [])).not.toContain("<owner-brief>");
  });
});

describe("image models", () => {
  it("skips masks only for gpt-image-2.5 models", () => {
    expect(supportsMask("gpt-image-2.5-sunburst")).toBe(false);
    expect(supportsMask("gpt-image-2.5-flare-2026-09-08")).toBe(false);
    expect(supportsMask("gpt-image-2")).toBe(true);
    expect(supportsMask("gpt-image-1.5")).toBe(true);
  });
});

describe("parallel runs", () => {
  it("never exceeds the limiter's concurrency, even with late arrivals", async () => {
    const run = createLimiter(2);
    let active = 0;
    let peak = 0;
    const task = () => run(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
    });
    const first = Array.from({ length: 5 }, task);
    await new Promise((r) => setTimeout(r, 3));
    await Promise.all([...first, ...Array.from({ length: 5 }, task)]);
    expect(peak).toBe(2);
  });

  it("keeps each run's log lines separate", async () => {
    const a: string[] = [];
    const b: string[] = [];
    const job = (sink: string[], name: string) =>
      logContext.run((m) => sink.push(m), async () => {
        for (let i = 0; i < 3; i += 1) {
          log(`${name} ${i}`);
          await new Promise((r) => setTimeout(r, 1));
        }
      });
    await Promise.all([job(a, "eastgate"), job(b, "renton")]);
    expect(a).toEqual(["eastgate 0", "eastgate 1", "eastgate 2"]);
    expect(b).toEqual(["renton 0", "renton 1", "renton 2"]);
  });
});

describe("cost estimates", () => {
  it("sums change ranges and repairs swapped or negative ranges", () => {
    const p = plan([{ costLow: 4000, costHigh: 6000 }, { costLow: 900, costHigh: 500 }, { costLow: -100, costHigh: 300 }]);
    expect(planCost(p)).toEqual({ low: 4500, high: 7200 });
    expect(planCost(plan([]))).toBeNull();
  });

  it("formats without false precision", () => {
    expect(formatUSD(840)).toBe("$850");
    expect(formatUSD(12_340)).toBe("$12.5K");
    expect(formatUSD(185_000)).toBe("$185K");
    expect(formatRange({ low: 18_000, high: 31_000 })).toBe("$18K–$31K");
  });

  it("counts each room once in the listing total, using the higher estimate", () => {
    const photo = (id: string, room: string, low: number, high: number) => ({
      id, basename: `${id}.jpg`, room, original: "", inventory,
      tiers: [{ tier: "moderate" as const, plan: plan([{ costLow: low, costHigh: high }]), status: "verified" as const, reasons: [], warnings: [], attempts: 1, editableShare: null, image: null, edges: [], judgement: null }],
    });
    const totals = listingTotals([
      photo("a", "great room", 20_000, 30_000),
      photo("b", "great room (toward dining)", 25_000, 40_000),
      photo("c", "kitchen", 50_000, 80_000),
    ]);
    expect(totals.get("moderate")).toEqual({ range: { low: 75_000, high: 120_000 }, rooms: 2 });
  });
});

describe("plain-language verification notes", () => {
  it("rewrites detector and judge phrasing", async () => {
    const { plainReason } = await import("../src/report.js");
    expect(plainReason("Edge structure shifted around window (Tall window over sink), r=0.38")).toBe("Window outline may have shifted (match 0.38): Tall window over sink");
    expect(plainReason("ceiling_line not preserved: The junction rises.")).toBe("Ceiling line changed: The junction rises.");
    expect(plainReason("plumbing_location: shower not preserved: Head moved.")).toBe("Plumbing location: shower changed: Head moved.");
    expect(plainReason("Openings were added, removed, or moved.")).toBe("A window or door opening was added, removed, or moved.");
  });
});
