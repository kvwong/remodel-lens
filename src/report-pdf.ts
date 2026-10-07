import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import PDFDocument from "pdfkit";
import sharp from "sharp";
import { WHIM_PATHS } from "./branding.js";

import { planCost, type CostRange } from "./redesign/plan.js";
import { ORIGINAL, pickKey, versionsFor, type VersionsFile } from "./redesign/versions.js";
import type { PhotoResult, TierResult } from "./redesign/run.js";
import { TIER_LABELS, TIER_RANK, type Tier } from "./redesign/tiers.js";
import {
  fixedSummary,
  formatRange,
  largestCosts,
  listingTotals,
  pickFeature,
  plainReason,
  roomName,
  sentence,
  showcase,
  STATUS,
  tierName,
  type Status,
} from "./report.js";

/**
 * Shareable PDF of a run's report, for someone who won't open the app.
 * Landscape, so listing photos and redesigns can sit side by side at a readable size.
 * "summary" is the cover, a before and after of every room with its costs, and what to know before deciding;
 * "full" adds every scope of every room: both photos large, what to check, and every planned change with its cost basis.
 */
export type PdfDetail = "summary" | "full";

export type ReportPdfInput = {
  title: string;
  photos: PhotoResult[];
  profileSummary: string;
  location?: string | null;
  run?: { startedAt: string; profileName?: string | null; stopped?: boolean };
  /** Folder the photo paths in `photos` are relative to. */
  runDir: string;
  detail: PdfDetail;
  /** Spot changes; rooms already show their picked version in `photos`. */
  versions?: VersionsFile;
};

export const PDF_DETAIL_LABELS: Record<PdfDetail, string> = { summary: "Summary", full: "Full scope" };

/* ---------- Page geometry and palette (matches the HTML report) ---------- */

const PAGE = { w: 792, h: 612 }; // US Letter, landscape
const M = 40;
const TOP = 38;
const BOTTOM = PAGE.h - 46; // content stops here; the footer sits below
const W = PAGE.w - M * 2;

const C = {
  text: "#1b1a19",
  muted: "#625e58",
  faint: "#8d8880",
  line: "#e2dfda",
  soft: "#f3f1ed",
  primary: "#2f5a44",
  primarySoft: "#e4eee7",
  verified: "#3d6a4c",
  review: "#8a6216",
  failed: "#9a3b2f",
  error: "#9a3b2f",
  unchanged: "#8d8880",
} as const;

const FONT_DIR = path.join(path.dirname(createRequire(import.meta.url).resolve("@fontsource/hanken-grotesk/LICENSE")), "files");
const FONTS = { regular: 400, medium: 500, bold: 600 } as const;
type FontName = keyof typeof FONTS;

/* ---------- Images ---------- */

type Img = { key: string; file: string; w: number; h: number };

/** Crops to 3:2 like the HTML report and re-encodes as JPEG so a 20-photo PDF stays a few MB. */
async function loadImages(wanted: Img[]): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  const unique = [...new Map(wanted.map((i) => [i.key, i])).values()];
  for (let i = 0; i < unique.length; i += 6) {
    await Promise.all(
      unique.slice(i, i + 6).map(async (img) => {
        if (!existsSync(img.file)) return;
        try {
          const buf = await sharp(img.file)
            .rotate()
            .resize({ width: Math.round(img.w), height: Math.round(img.h), fit: "cover" })
            .jpeg({ quality: 80, mozjpeg: true })
            .toBuffer();
          out.set(img.key, buf);
        } catch {
          // An unreadable image draws as an empty frame rather than failing the whole PDF.
        }
      }),
    );
  }
  return out;
}

/** Resolve a run-relative image path, refusing anything that escapes the run folder. */
export function runFile(runDir: string, rel: string | null): string | null {
  if (!rel) return null;
  const full = path.resolve(runDir, rel);
  return full.startsWith(path.resolve(runDir) + path.sep) ? full : null;
}

/* ---------- Rendering ---------- */

export async function renderReportPdf(input: ReportPdfInput): Promise<Buffer> {
  const { photos, detail } = input;
  const full = detail === "full";
  const tiers = [...new Set(photos.flatMap((p) => p.tiers.map((t) => t.tier)))].sort((a, b) => TIER_RANK[a] - TIER_RANK[b]);
  const totals = listingTotals(photos);
  const feature = pickFeature(photos);
  const heroTier = feature ? showcase(feature, null) : null;
  const preferred = heroTier?.tier ?? null;

  // Sizes are in points; images are rendered at 2x for print sharpness. All photos keep the report's 3:2 crop.
  const PAIR = { w: (W - 16) / 2, h: (W - 16) / 3 }; // listing photo and redesign side by side, full page width
  const ROW = { w: 204, h: 136 }; // room-by-room gallery
  const wanted: Img[] = [];
  const want = (rel: string | null, size: { w: number; h: number }) => {
    const file = runFile(input.runDir, rel);
    if (file) wanted.push({ key: `${rel}@${size.w}`, file, w: size.w * 2, h: size.h * 2 });
  };
  if (feature) {
    want(feature.original, PAIR);
    want(heroTier?.image ?? null, PAIR);
  }
  for (const p of photos) {
    want(p.original, ROW);
    want(showcase(p, preferred)?.image ?? null, ROW);
    if (full) {
      want(p.original, PAIR);
      for (const t of p.tiers) want(t.image, PAIR);
    }
  }
  const images = await loadImages(wanted);

  const started = input.run ? new Date(input.run.startedAt) : null;
  const doc = new PDFDocument({
    size: "LETTER",
    layout: "landscape",
    margins: { top: TOP, bottom: 24, left: M, right: M },
    bufferPages: true,
    info: {
      Title: `${input.title}: remodel ${full ? "full scope" : "summary"}`,
      Author: "Whim",
      Subject: "Remodel scopes and cost estimates",
      ...(started ? { CreationDate: started } : {}),
    },
  });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  for (const [name, weight] of Object.entries(FONTS)) doc.registerFont(name, path.join(FONT_DIR, `hanken-grotesk-latin-${weight}-normal.woff`));

  /* Text helpers. The font covers Latin only, so swap in look-alikes for symbols the model likes ("≈", "→"). */
  doc.font("regular");
  const glyphs = (doc as unknown as { _font?: { font?: { hasGlyphForCodePoint?: (c: number) => boolean } } })._font?.font;
  const SWAPS: Record<string, string> = { "≈": "~", "←": "", "×": "x", "≥": ">=", "≤": "<=", "′": "'", "″": '"', "✓": "", "⁄": "/" };
  const clean = (s: string) =>
    [...s.replace(/[\u00a0\u2009\u202f]/g, " ").replace(/\s*\u2192\s*/g, " to ")]
      .map((ch) => SWAPS[ch] ?? (glyphs?.hasGlyphForCodePoint && !glyphs.hasGlyphForCodePoint(ch.codePointAt(0)!) && ch.trim() ? "" : ch))
      .join("");

  type TextOpts = { font?: FontName; size?: number; color?: string; align?: "left" | "right" | "center"; lineGap?: number; spacing?: number };
  const style = (o: TextOpts) => {
    doc.font(o.font ?? "regular").fontSize(o.size ?? 9.5).fillColor(o.color ?? C.text);
  };
  const measure = (s: string, w: number, o: TextOpts = {}) => {
    style(o);
    return doc.heightOfString(clean(s), { width: w, lineGap: o.lineGap ?? 1.5, characterSpacing: o.spacing ?? 0 });
  };
  const write = (s: string, x: number, at: number, w: number, o: TextOpts = {}) => {
    style(o);
    const text = clean(s);
    const opts = { width: w, lineGap: o.lineGap ?? 1.5, align: o.align ?? "left", characterSpacing: o.spacing ?? 0 };
    const h = doc.heightOfString(text, opts);
    doc.text(text, x, at, opts);
    return h;
  };
  const rule = (at: number, x = M, w = W, color: string = C.line) => {
    doc.moveTo(x, at).lineTo(x + w, at).lineWidth(0.6).strokeColor(color).stroke();
  };
  const label = (s: string, x: number, at: number, w = W) => write(s.toUpperCase(), x, at, w, { font: "medium", size: 7.5, color: C.muted, spacing: 0.9 });

  let y = TOP;
  const newPage = () => {
    doc.addPage();
    y = TOP;
  };
  const ensure = (h: number) => {
    if (y + h > BOTTOM) newPage();
  };

  /** Draws a prepared image (looked up by the size it was loaded at), optionally scaled to `box`. */
  const picture = (rel: string | null, size: { w: number; h: number }, x: number, at: number, empty = "No image", box = size) => {
    const buf = rel ? images.get(`${rel}@${size.w}`) : undefined;
    if (buf) {
      doc.save().roundedRect(x, at, box.w, box.h, 3).clip();
      doc.image(buf, x, at, { width: box.w, height: box.h });
      doc.restore();
    } else {
      doc.roundedRect(x, at, box.w, box.h, 3).fill(C.soft);
      write(empty, x + 8, at + box.h / 2 - 6, box.w - 16, { size: 8.5, color: C.muted, align: "center" });
    }
  };

  /** Colored dot plus the status name, e.g. "● Verified". Returns the drawn width. */
  const statusMark = (status: Status, x: number, at: number, o: { size?: number; meaning?: boolean; w?: number } = {}) => {
    const size = o.size ?? 8;
    doc.circle(x + 3, at + size * 0.62, 2.6).fill(C[status]);
    const text = STATUS[status].label + (o.meaning ? `. ${STATUS[status].meaning}` : "");
    return write(text, x + 10, at, (o.w ?? 200) - 10, { size, font: "medium", color: C.text });
  };

  const bullets = (items: string[], x: number, w: number, o: TextOpts = {}) => {
    for (const item of items) {
      const h = measure(item, w - 10, o);
      ensure(h + 3);
      write("•", x, y, 8, { ...o, color: C.faint });
      write(item, x + 10, y, w - 10, o);
      y += h + 3;
    }
  };

  /** Section title, kept on the same page as at least `keep` points of what follows it. */
  const heading = (s: string, keep = 60, gapAbove = 26) => {
    ensure(gapAbove + 30 + keep);
    if (y > TOP) y += gapAbove;
    y += write(s, M, y, W, { font: "bold", size: 14 });
    y += 10;
  };

  const tally = (tier: Tier) => {
    const list = photos.map((p) => p.tiers.find((t) => t.tier === tier)).filter((t): t is TierResult => !!t);
    const n = (s: Status) => list.filter((t) => t.status === s).length;
    return { total: list.length, verified: n("verified"), review: n("review"), failed: n("failed") + n("error") };
  };

  /* ---------- Cover ---------- */

  doc.save().translate(M, y).scale(105 / 1405).translate(-185, -269);
  doc.path(WHIM_PATHS.mark).fill(C.primary, "even-odd");
  doc.path(WHIM_PATHS.wordmark).fill(C.text, "even-odd");
  doc.restore();
  label(full ? "Full scope report" : "Summary", M + 120, y + 8);
  y += 36;
  y += write(input.title, M, y, W, { font: "bold", size: 26, lineGap: 0 });
  y += 4;
  const dateText = started ? new Intl.DateTimeFormat("en-US", { dateStyle: "long" }).format(started) : null;
  const meta = [
    input.location?.replace(/\s*\(.*\)$/, ""),
    dateText,
    input.run?.profileName ? `${input.run.profileName} taste profile` : null,
    `${photos.length} ${photos.length === 1 ? "photo" : "photos"}`,
  ].filter(Boolean) as string[];
  y += write(meta.join("   ·   "), M, y, W, { size: 9.5, color: C.muted });
  if (input.run?.stopped) {
    y += 4;
    y += write("This run was stopped early, so some rooms or scopes are missing.", M, y, W, { size: 9, color: C.review });
  }

  // The cover's photos shrink if a long title leaves less room, so the cost cards always fit below.
  const cardH = 74;
  const coverRest = 14 + 26 + 18 + 14 + cardH + 12 + 24;
  const heroH = Math.min(PAIR.h, BOTTOM - (y + 16) - coverRest);
  const HERO = { w: heroH * 1.5, h: heroH };
  if (feature) {
    y += 16;
    const room = roomName(feature);
    label(heroTier ? `The ${room.toLowerCase()}, before and after` : `The ${room.toLowerCase()}`, M, y);
    y += 14;
    picture(feature.original, PAIR, M, y, "No image", HERO);
    picture(heroTier?.image ?? null, PAIR, M + HERO.w + 16, y, "No redesign image", HERO);
    y += HERO.h + 7;
    write("Listing photo", M, y, HERO.w, { font: "medium", size: 9 });
    write("As photographed", M, y + 12, HERO.w, { size: 8.5, color: C.muted });
    if (heroTier) {
      const x = M + HERO.w + 16;
      write(`${tierName(heroTier.tier)} redesign`, x, y, HERO.w, { font: "medium", size: 9 });
      write(TIER_LABELS[heroTier.tier].blurb, x, y + 12, HERO.w, { size: 8.5, color: C.muted });
      const tag = STATUS[heroTier.status].label;
      style({ font: "medium", size: 8 });
      const tw = doc.widthOfString(tag) + 10;
      statusMark(heroTier.status, x + HERO.w - tw, y + 1, { w: tw + 4 });
    }
    y += 26;
  }

  // Whole-listing estimate per scope
  y += 18;
  label("Estimated cost for the whole listing", M, y);
  y += 14;
  if (tiers.length) {
    const gap = 12;
    const cw = (W - gap * (tiers.length - 1)) / tiers.length;
    tiers.forEach((tier, i) => {
      const x = M + i * (cw + gap);
      const x0 = x + 16;
      const iw = cw - 32;
      const t = totals.get(tier);
      const c = tally(tier);
      doc.roundedRect(x, y, cw, cardH, 8).fill(tier === preferred ? C.primarySoft : C.soft);
      write(tierName(tier), x0, y + 13, iw, { font: "bold", size: 11 });
      write(TIER_LABELS[tier].blurb, x0, y + 13, iw, { size: 8, color: C.muted, align: "right" });
      write(t ? formatRange(t.range) : "No estimate", x0, y + 31, iw, { font: "medium", size: 18, color: t ? C.text : C.muted });
      const sub = [t ? `${t.rooms} ${t.rooms === 1 ? "room" : "rooms"}` : null, `${c.verified} of ${c.total} verified`].filter(Boolean).join(" · ");
      write(sub, x0, y + 55, iw, { size: 8, color: C.muted });
    });
    y += cardH;
  }
  y += 12;
  const where = input.location?.replace(/\s*\(.*\)$/, "") || "a typical US metro";
  y += write(
    `Installed costs (materials and labor) for ${where}, in ${new Date().getFullYear()} dollars, from quantities visible in each photo. Most changes are priced from a unit-cost table (Homewyse national figures adjusted for local construction wages from BLS, material grade, and 20% contractor overhead and permits); the rest, such as furniture and appliances, are model estimates. Rooms photographed from more than one angle are counted once. A ballpark for comparing scopes, not a contractor bid.`,
    M,
    y,
    W,
    { size: 8, color: C.muted, lineGap: 2 },
  );

  /* ---------- Room by room ---------- */

  const legendLine = (at: number) => {
    // Right-aligned key for the status dots: "● Verified  ● Needs review  ● Structure changed"
    const items = (["verified", "review", "failed"] as const).map((s) => ({ s, w: (style({ font: "medium", size: 8 }), doc.widthOfString(STATUS[s].label) + 22) }));
    let x = M + W - items.reduce((a, i) => a + i.w, 0);
    for (const i of items) {
      statusMark(i.s, x, at, { w: i.w });
      x += i.w;
    }
  };

  newPage();
  write("Room by room", M, y, W, { font: "bold", size: 14 });
  legendLine(y + 4);
  y += 20;
  y += write(
    preferred
      ? `Each room's listing photo next to its redesign (${tierName(preferred)} where it held up, otherwise the next best), with the estimate at every scope.`
      : "Each room's listing photo with the estimate at every scope.",
    M,
    y,
    W,
    { size: 9, color: C.muted },
  );
  y += 12;

  const infoX = M + ROW.w * 2 + 10 + 20;
  const infoW = M + W - infoX;
  const rowH = ROW.h + 18;
  for (const p of photos) {
    const shown = showcase(p, preferred);
    ensure(rowH);
    picture(p.original, ROW, M, y);
    picture(shown?.image ?? null, ROW, M + ROW.w + 10, y, "No redesign image");
    write("Listing photo", M, y + ROW.h + 3, ROW.w, { size: 7.5, color: C.muted });
    if (shown) write(`${tierName(shown.tier)} redesign`, M + ROW.w + 10, y + ROW.h + 3, ROW.w, { size: 7.5, color: C.muted });

    let iy = y;
    iy += write(roomName(p), infoX, iy, infoW, { font: "bold", size: 12 }) + 8;
    for (const tier of tiers) {
      const t = p.tiers.find((r) => r.tier === tier);
      const cost = t ? planCost(t.plan) : null;
      write(tierName(tier), infoX, iy, 70, { size: 9, color: C.muted });
      write(t ? (cost ? formatRange(cost) : "–") : "Not run", infoX + 70, iy, 90, { font: "medium", size: 9.5, color: t ? C.text : C.muted });
      if (t) statusMark(t.status, infoX + 166, iy + 1, { w: infoW - 166, size: 8 });
      iy += 18;
      rule(iy - 5, infoX, infoW);
    }
    y += rowH;
  }
  if (totals.size) {
    ensure(26);
    write("Whole listing", infoX - 120, y, 110, { font: "bold", size: 10, align: "right" });
    let ty = y;
    for (const tier of tiers) {
      const t = totals.get(tier);
      write(tierName(tier), infoX, ty, 70, { size: 9, color: C.muted });
      write(t ? formatRange(t.range) : "–", infoX + 70, ty, 120, { font: "bold", size: 10 });
      ty += 16;
    }
    y = ty + 4;
  }

    /* ---------- Where the money goes ---------- */

  const driverCols = tiers.map((tier) => ({ tier, drivers: largestCosts(photos, tier) })).filter((d) => d.drivers.length);
  if (driverCols.length) {
    const gap = 16;
    const cw = (W - gap * (driverCols.length - 1)) / driverCols.length;
    const amountW = 62;
    const rows = driverCols.map(({ drivers }) => drivers.map(({ room, c }) => ({ text: `${room}: ${sentence(c.element)}`, cost: formatRange({ low: Math.min(c.costLow, c.costHigh), high: Math.max(c.costLow, c.costHigh) }) })));
    const rowHeights = rows.map((list) => list.map((r) => measure(r.text, cw - amountW - 6, { size: 8.5 }) + 9));
    const blockH = 40 + Math.max(...rowHeights.map((hs) => hs.reduce((a, b) => a + b, 0)));
    heading("Where the money goes", blockH);
    driverCols.forEach(({ tier }, i) => {
      const x = M + i * (cw + gap);
      let cy = y;
      write(tierName(tier), x, cy, cw, { font: "bold", size: 10.5 });
      const t = totals.get(tier);
      if (t) write(formatRange(t.range), x, cy + 1, cw, { font: "medium", size: 9.5, align: "right" });
      cy += 17;
      rule(cy, x, cw, C.text);
      cy += 3;
      write("Largest costs", x, cy + 3, cw, { size: 7.5, color: C.muted });
      cy += 15;
      rows[i]!.forEach((r, j) => {
        write(r.text, x, cy, cw - amountW - 6, { size: 8.5 });
        write(r.cost, x + cw - amountW, cy, amountW, { size: 8.5, font: "medium", align: "right" });
        cy += rowHeights[i]![j]!;
        rule(cy - 4, x, cw);
      });
    });
    y += blockH;
  }

  /* ---------- Before you decide ---------- */

  const shaky = tiers
    .map((tier) => ({ tier, rooms: [...new Set(photos.filter((p) => ["failed", "error"].includes(p.tiers.find((t) => t.tier === tier)?.status ?? "")).map(roomName))] }))
    .filter((s) => s.rooms.length);
  const flags = [...new Set(photos.flatMap((p) => p.tiers.flatMap((t) => t.plan.feasibilityFlags.map((f) => `${roomName(p)}: ${f}`))))];
  if (shaky.length || flags.length || input.profileSummary) {
    heading("Before you decide");
    if (shaky.length) {
      ensure(40);
      y += write("Use for inspiration only", M, y, W, { font: "bold", size: 9.5 });
      y += 3;
      y += write("In these images the walls, windows, or camera angle drifted from the listing, so they shouldn't drive a decision.", M, y, W, { size: 8.5, color: C.muted });
      y += 5;
      bullets(shaky.map((s) => `${tierName(s.tier)}: ${s.rooms.join(", ")}`), M, W, { size: 9 });
      y += 10;
    }
    if (flags.length) {
      const shown = full ? flags : flags.slice(0, 6);
      ensure(40);
      y += write("Check with a contractor", M, y, W, { font: "bold", size: 9.5 });
      y += 5;
      bullets(shown, M, W, { size: 9 });
      if (shown.length < flags.length) {
        y += 2;
        y += write(`${flags.length - shown.length} more in the full scope report.`, M + 10, y, W - 10, { size: 8.5, color: C.muted });
      }
      y += 10;
    }
    if (input.profileSummary) {
      ensure(40);
      y += write("Taste applied", M, y, W, { font: "bold", size: 9.5 });
      y += 4;
      y += write(input.profileSummary, M, y, W, { size: 9, color: C.muted, lineGap: 2 });
    }
  }

  /* ---------- Full scope: every scope of every room, listing photo and redesign side by side ---------- */

  if (full) {
    const colGap = 24;
    const colW = (W - colGap) / 2;
    photos.forEach((p, n) => {
      newPage();
      const room = roomName(p);
      label(`Room ${n + 1} of ${photos.length}`, M, y);
      y += 14;
      write(room, M, y, W, { font: "bold", size: 20, lineGap: 0 });
      write(`Kept as is: ${fixedSummary(p) || "nothing structural detected"}`, M, y + 6, W, { size: 8.5, color: C.muted, align: "right" });
      y += 28;
      const today = [p.inventory.condition && sentence(p.inventory.condition), p.inventory.uncertainties.length ? `Can't tell from this photo: ${p.inventory.uncertainties.join("; ")}.` : ""].filter(Boolean).join(" ");
      if (today) y += write(today, M, y, W, { size: 8.5, color: C.muted, lineGap: 2 }) + 4;

      p.tiers.forEach((t) => {
        const total = planCost(t.plan);
        // A scope starts with its header and both photos together, on a fresh page if they don't fit.
        ensure(30 + PAIR.h + 40);
        y += 10;
        write(tierName(t.tier), M, y, W, { font: "bold", size: 14 });
        style({ font: "bold", size: 14 });
        const nw = doc.widthOfString(tierName(t.tier));
        write(TIER_LABELS[t.tier].blurb, M + nw + 10, y + 4.5, W - nw - 160, { size: 9, color: C.muted });
        if (total) write(formatRange(total), M, y, W, { font: "medium", size: 14, align: "right" });
        y += 21;
        rule(y, M, W, C.text);
        y += 8;

        const rx = M + PAIR.w + 16;
        picture(p.original, PAIR, M, y);
        picture(t.image, PAIR, rx, y, `${STATUS[t.status].label}. ${STATUS[t.status].meaning}.`);
        y += PAIR.h + 6;
        write("Listing photo", M, y, PAIR.w, { size: 8.5, color: C.muted });
        statusMark(t.status, rx, y, { size: 8.5, meaning: true, w: PAIR.w * 0.5 });
        const openings = t.edges.length ? `${t.edges.filter((e) => e.pass).length} of ${t.edges.length} openings match` : null;
        const fine = [openings, t.judgement ? `plan followed ${t.judgement.planAdherence}/10` : null].filter(Boolean).join(" · ");
        if (fine) write(sentence(fine), rx + PAIR.w * 0.5, y + 0.5, PAIR.w * 0.5, { size: 7.5, color: C.faint, align: "right" });
        y += 16;

        const pickedId = input.versions?.picks[pickKey(p.id, t.tier)];
        const picked = pickedId && pickedId !== ORIGINAL ? input.versions!.versions.find((v) => v.id === pickedId && v.photoId === p.id && v.tier === t.tier) : null;
        if (picked) {
          const asks = [picked.request.ask, ...picked.request.pins.map((pin) => `${sentence(pin.item ?? "Pinned spot")}: ${pin.note}`)].filter(Boolean).join("; ");
          ensure(14);
          y += write(`Version ${picked.id.slice(1)} of ${versionsFor(input.versions!, p.id, t.tier).length + 1}. Your change: ${asks}`, M, y, W, { size: 8.5, color: C.muted }) + 4;
        }
        const direction = [t.plan.expression && sentence(t.plan.expression), t.plan.architecturalLanguage].filter(Boolean).join(" · ");
        if (direction) {
          ensure(14);
          y += write(direction, M, y, W, { size: 8.5, color: C.muted }) + 4;
        }
        const reasons = t.reasons.map(plainReason);
        if (reasons.length) {
          ensure(30);
          y += write("What to check", M, y, W, { font: "medium", size: 9 }) + 3;
          bullets(reasons, M, W, { size: 8.5 });
          y += 4;
        }

        // Planned changes in two columns, row by row, so a long list still reads top to bottom.
        const changes = t.plan.changes;
        if (changes.length) {
          const amountW = 84;
          const textW = colW - amountW - 8;
          const item = (c: (typeof changes)[number]) => {
            const basis = c.costBasis ? `${c.costSource === "estimate" ? "Model estimate, not from the cost table: " : ""}${c.costBasis}` : "";
            return { c, basis, h: measure(sentence(c.element), textW, { font: "bold", size: 9.5 }) + measure(c.proposed, colW, { size: 9 }) + measure(`Now: ${c.current}`, colW, { size: 8.5 }) + (basis ? measure(basis, colW, { size: 8 }) + 1 : 0) + 6 };
          };
          const drawItem = ({ c, basis }: ReturnType<typeof item>, x: number) => {
            let cy = y;
            cy += write(sentence(c.element), x, cy, textW, { font: "bold", size: 9.5 }) + 1;
            if (Number.isFinite(c.costLow) && Number.isFinite(c.costHigh)) {
              write(formatRange({ low: Math.min(c.costLow, c.costHigh), high: Math.max(c.costLow, c.costHigh) } satisfies CostRange), x + colW - amountW, y, amountW, { font: "medium", size: 9.5, align: "right" });
            }
            cy += write(c.proposed, x, cy, colW, { size: 9 });
            cy += write(`Now: ${c.current}`, x, cy + 1, colW, { size: 8.5, color: C.muted }) + 1;
            if (basis) write(basis, x, cy + 1, colW, { size: 8, color: C.faint });
          };
          // Keep the section label with its first row of changes.
          ensure(18 + Math.max(...changes.slice(0, 2).map((c) => item(c).h)) + 10);
          y += 4;
          label(`Planned changes (${changes.length})`, M, y);
          y += 14;
          for (let i = 0; i < changes.length; i += 2) {
            const pair = changes.slice(i, i + 2).map(item);
            const h = Math.max(...pair.map((x) => x.h));
            ensure(h + 10);
            pair.forEach((it, j) => drawItem(it, M + j * (colW + colGap)));
            y += h + 4;
            pair.forEach((_, j) => rule(y, M + j * (colW + colGap), colW));
            y += 8;
          }
        }

        // Walls, beyond-scope work, and contractor checks side by side.
        const extra = ([
          ["Walls removed", t.plan.removedWalls],
          ["For the full look, beyond this scope", t.plan.beyondScope ?? []],
          ["Check with a contractor", t.plan.feasibilityFlags],
        ] as Array<[string, string[]]>).filter(([, items]) => items.length);
        if (extra.length) {
          const ew = (W - colGap * (extra.length - 1)) / extra.length;
          const heights = extra.map(([, items]) => 16 + items.reduce((a, s) => a + measure(s, ew - 10, { size: 8.5 }) + 3, 0));
          ensure(Math.max(...heights) + 6);
          y += 2;
          extra.forEach(([title, items], i) => {
            const x = M + i * (ew + colGap);
            let ey = y;
            ey += write(title, x, ey, ew, { font: "medium", size: 9, color: C.muted }) + 4;
            for (const s of items) {
              write("•", x, ey, 8, { size: 8.5, color: C.faint });
              ey += write(s, x + 10, ey, ew - 10, { size: 8.5 }) + 3;
            }
          });
          y += Math.max(...heights) + 6;
        }
      });
    });
  }

    /* ---------- Footer on every page ---------- */

  const range = doc.bufferedPageRange();
  const footer = `${input.title} · ${PDF_DETAIL_LABELS[detail]}${dateText ? ` · ${dateText}` : ""}`;
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0; // writing below the bottom margin would otherwise start a new page
    rule(PAGE.h - 34);
    write(footer, M, PAGE.h - 27, W - 80, { size: 7.5, color: C.faint });
    write(`${i - range.start + 1} of ${range.count}`, M + W - 80, PAGE.h - 27, 80, { size: 7.5, color: C.faint, align: "right" });
  }

  doc.end();
  return done;
}

/** "Maple St – Remodel summary.pdf", safe for a Content-Disposition header. */
export function pdfFilename(title: string, detail: PdfDetail): string {
  const base = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "Listing";
  return `${base} - Remodel ${detail === "full" ? "full scope" : "summary"}.pdf`;
}
