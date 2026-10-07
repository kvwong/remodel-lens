import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ChangePlan } from "../src/redesign/plan.js";
import type { PhotoResult, TierResult } from "../src/redesign/run.js";
import { renderReport } from "../src/report.js";
import { pdfFilename, renderReportPdf } from "../src/report-pdf.js";
import { htmlFilename, renderReportHtml } from "../src/report-html.js";

const runDir = mkdtempSync(path.join(tmpdir(), "remodel-lens-pdf-"));

const plan = (tier: ChangePlan["tier"]): ChangePlan => ({
  tier,
  expression: "quiet warmth",
  architecturalLanguage: "traditional",
  changes: [
    { element: "wall paint", current: "beige", proposed: "warm white", minTier: "cosmetic", costItem: "other", quantity: 0, grade: "mid", costLow: 2000, costHigh: 3500, costBasis: "≈320 sq ft → two coats", costSource: "table", tasteRules: [], note: null },
  ],
  removedWalls: [],
  preserve: [],
  feasibilityFlags: tier === "moderate" ? ["Check for asbestos in the old flooring."] : [],
  beyondScope: [],
  rationale: "",
});

const tier = (t: ChangePlan["tier"], status: TierResult["status"], image: string | null): TierResult => ({
  tier: t, plan: plan(t), status, reasons: status === "failed" ? ["Camera viewpoint changed."] : [], warnings: [], attempts: 1, editableShare: 0.4, image, edges: [], judgement: null,
});

const photo = (id: string, room: string): PhotoResult => ({
  id,
  basename: `${id}.jpg`,
  room,
  original: `${id}/original.png`,
  inventory: { roomType: room, camera: "", fixed: [], changeable: [], walls: [], condition: "Dated but sound.", uncertainties: ["Subfloor condition"] },
  tiers: [tier("cosmetic", "verified", `${id}/cosmetic.png`), tier("moderate", id === "p2" ? "failed" : "review", `${id}/missing.png`)],
});

const photos = [photo("p1", "kitchen"), photo("p2", "living room")];
const pageCount = (pdf: Buffer) => pdf.toString("latin1").match(/\/Type \/Page\b/g)?.length ?? 0;

beforeAll(async () => {
  for (const id of ["p1", "p2"]) {
    mkdirSync(path.join(runDir, id), { recursive: true });
    const png = sharp({ create: { width: 300, height: 200, channels: 3, background: "#d9cbb5" } }).png();
    await png.clone().toFile(path.join(runDir, id, "original.png"));
    await png.clone().toFile(path.join(runDir, id, "cosmetic.png"));
  }
});
afterAll(() => rmSync(runDir, { recursive: true, force: true }));

describe("report PDF", () => {
  it("renders a short summary and a longer full scope, tolerating missing images", async () => {
    const base = { title: "12 Maple St", photos, profileSummary: "Warm and quiet.", location: "Bellevue, WA", run: { startedAt: "2026-10-04T18:00:00Z" }, runDir };
    const summary = await renderReportPdf({ ...base, detail: "summary" });
    const full = await renderReportPdf({ ...base, detail: "full" });
    expect(summary.subarray(0, 5).toString()).toBe("%PDF-");
    expect(full.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pageCount(summary)).toBeGreaterThanOrEqual(2);
    expect(pageCount(full)).toBeGreaterThan(pageCount(summary));
  });

  it("names files safely", () => {
    expect(pdfFilename('12 Maple St / Unit "B"', "full")).toBe("12 Maple St Unit B - Remodel full scope.pdf");
    expect(pdfFilename("", "summary")).toBe("Listing - Remodel summary.pdf");
  });

  it("shows download links in the report only when the app can serve them", () => {
    const html = renderReport({ title: "12 Maple St", photos, profileSummary: "", pdf: { summary: "/pdf/runs/maple/r1?detail=summary", full: "/pdf/runs/maple/r1?detail=full" } });
    expect(html).toContain('href="/pdf/runs/maple/r1?detail=summary"');
    expect(html).toContain('href="/pdf/runs/maple/r1?detail=full"');
    const both = renderReport({ title: "12 Maple St", photos, profileSummary: "", pdf: { summary: "/p?s", full: "/p?f" }, html: { summary: "/h?s", full: "/h?f" } });
    expect(both).toContain(">Summary HTML</a>");
    expect(both).toContain(">Full scope HTML</a>");
    expect(renderReport({ title: "12 Maple St", photos, profileSummary: "" })).not.toContain("data-download=");
  });
});

describe("report HTML", () => {
  const base = { title: "12 Maple St", photos, profileSummary: "Warm and quiet.", location: "Bellevue, WA", run: { startedAt: "2026-10-04T18:00:00Z" }, runDir };

  it("embeds every photo and the font, so the file works on its own", async () => {
    for (const detail of ["summary", "full"] as const) {
      const html = await renderReportHtml({ ...base, detail });
      const sources = [...html.matchAll(/<img\b[^>]*\ssrc="([^"]*)"/g)].map((m) => m[1]!);
      // Only the missing moderate images keep their path; everything else is inline.
      expect(sources.filter((s) => !s.startsWith("data:"))).toEqual(sources.filter((s) => s.endsWith("missing.png")));
      expect(sources.some((s) => s.startsWith("data:image/webp;base64,"))).toBe(true);
      expect(html).not.toContain("fonts.googleapis.com");
      expect(html).toContain("data:font/woff2;base64,");
      expect(html).not.toContain(" data-src=");
      expect(html).not.toContain("data-download=");
      expect(html).not.toContain('class="iter-panel');
    }
  });

  it("shows one redesign per room in the summary and every scope in the full scope", async () => {
    const summary = await renderReportHtml({ ...base, detail: "summary" });
    const full = await renderReportHtml({ ...base, detail: "full" });
    expect(summary).toContain('class="info-tier scope-lines"');
    expect(summary).not.toContain('<button role="tab"');
    expect(summary).not.toContain("Planned changes");
    expect(full).toContain('<button role="tab"');
    expect(full).toContain("Planned changes");
  });

  it("names files safely", () => {
    expect(htmlFilename('12 Maple St / Unit "B"', "full")).toBe("12 Maple St Unit B - Remodel full scope.html");
    expect(htmlFilename("", "summary")).toBe("Listing - Remodel summary.html");
  });
});
