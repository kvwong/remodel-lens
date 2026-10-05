import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import PDFDocument from "pdfkit";
import sharp from "sharp";

import { planCost, type CostRange } from "./redesign/plan.js";
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
  STATUS,
  tierName,
  type Status,
} from "./report.js";

/**
 * Shareable PDF of a run's report, for someone who won't open the app.
 * "summary" is the cover, room-by-room costs, and what to know before deciding (about three pages);
 * "full" adds a page per room with every planned change, its cost basis, and what to check.
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
};

export const PDF_DETAIL_LABELS: Record<PdfDetail, string> = { summary: "Summary", full: "Full scope" };

/* ---------- Page geometry and palette (matches the HTML report) ---------- */

const PAGE = { w: 612, h: 792 }; // US Letter
const M = 54; // 0.75in side margins
const TOP = 54;
const BOTTOM = PAGE.h - 64; // content stops here; the footer sits below
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
function runFile(runDir: string, rel: string | null): string | null {
  if (!rel) return null;
  const full = path.resolve(runDir, rel);
  return full.startsWith(path.resolve(runDir) + path.sep) ? full : null;
}

/* ---------- Choosing what to show ---------- */

const usable = (t: TierResult | undefined): t is TierResult & { image: string } => !!t?.image && (t.status === "verified" || t.status === "review");

/** The redesign to put next to a listing photo: the preferred scope if it's trustworthy, else the most ambitious trustworthy one. */
function showcase(photo: PhotoResult, preferred: Tier | null): TierResult | null {
  const pref = photo.tiers.find((t) => t.tier === preferred);
  if (usable(pref)) return pref;
  const ranked = [...photo.tiers].sort((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier]);
  return ranked.find(usable) ?? ranked.find((t) => !!t.image) ?? null;
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

  // Sizes are in points; images are rendered at 2× for print sharpness.
  const HERO = { w: (W - 12) / 2, h: (W - 12) / 3 };
  const THUMB = { w: 76, h: 76 / 1.5 };
  const ROOM_IMG = { w: 216, h: 144 };
  const wanted: Img[] = [];
  const want = (rel: string | null, size: { w: number; h: number }) => {
    const file = runFile(input.runDir, rel);
    if (file) wanted.push({ key: `${rel}@${size.w}`, file, w: size.w * 2, h: size.h * 2 });
  };
  if (feature) {
    want(feature.original, HERO);
    want(heroTier?.image ?? null, HERO);
  }
  for (const p of photos) {
    want(p.original, THUMB);
    want(showcase(p, preferred)?.image ?? null, THUMB);
    if (full) {
      want(p.original, ROOM_IMG);
      for (const t of p.tiers) want(t.image, ROOM_IMG);
    }
  }
  const images = await loadImages(wanted);

  const started = input.run ? new Date(input.run.startedAt) : null;
  const doc = new PDFDocument({
    size: "LETTER",
    margins: { top: TOP, bottom: 24, left: M, right: M },
    bufferPages: true,
    info: {
      Title: `${input.title}: remodel ${full ? "full scope" : "summary"}`,
      Author: "Remodel Lens",
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

  const picture = (rel: string | null, size: { w: number; h: number }, x: number, at: number, empty = "No image") => {
    const buf = rel ? images.get(`${rel}@${size.w}`) : undefined;
    if (buf) {
      doc.save().roundedRect(x, at, size.w, size.h, 3).clip();
      doc.image(buf, x, at, { width: size.w, height: size.h });
      doc.restore();
    } else {
      doc.roundedRect(x, at, size.w, size.h, 3).fill(C.soft);
      write(empty, x + 8, at + size.h / 2 - 6, size.w - 16, { size: 8.5, color: C.muted, align: "center" });
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
    y += gapAbove;
    y += write(s, M, y, W, { font: "bold", size: 14 });
    y += 10;
  };

  const tally = (tier: Tier) => {
    const list = photos.map((p) => p.tiers.find((t) => t.tier === tier)).filter((t): t is TierResult => !!t);
    const n = (s: Status) => list.filter((t) => t.status === s).length;
    return { total: list.length, verified: n("verified"), review: n("review"), failed: n("failed") + n("error") };
  };

  /* ---------- Cover ---------- */

  label(`Remodel Lens · ${full ? "Full scope report" : "Summary"}`, M, y);
  y += 18;
  y += write(input.title, M, y, W, { font: "bold", size: 26, lineGap: 0 });
  y += 6;
  const dateText = started ? new Intl.DateTimeFormat("en-US", { dateStyle: "long" }).format(started) : null;
  const meta = [
    input.location?.replace(/\s*\(.*\)$/, ""),
    dateText,
    input.run?.profileName ? `${input.run.profileName} taste profile` : null,
    `${photos.length} ${photos.length === 1 ? "photo" : "photos"}`,
  ].filter(Boolean) as string[];
  y += write(meta.join("   ·   "), M, y, W, { size: 9.5, color: C.muted });
  if (input.run?.stopped) {
    y += 6;
    y += write("This run was stopped early, so some rooms or scopes are missing.", M, y, W, { size: 9, color: C.review });
  }

  if (feature) {
    y += 22;
    const room = roomName(feature);
    label(heroTier ? `The ${room.toLowerCase()}, before and after` : `The ${room.toLowerCase()}`, M, y);
    y += 14;
    picture(feature.original, HERO, M, y);
    picture(heroTier?.image ?? null, HERO, M + HERO.w + 12, y, "No redesign image");
    y += HERO.h + 7;
    write("Listing photo", M, y, HERO.w, { font: "medium", size: 9 });
    write("As photographed", M, y + 12, HERO.w, { size: 8.5, color: C.muted });
    if (heroTier) {
      const x = M + HERO.w + 12;
      write(`${tierName(heroTier.tier)} redesign`, x, y, HERO.w, { font: "medium", size: 9 });
      write(TIER_LABELS[heroTier.tier].blurb, x, y + 12, HERO.w, { size: 8.5, color: C.muted });
      const tag = STATUS[heroTier.status].label;
      style({ font: "medium", size: 8 });
      const tw = doc.widthOfString(tag) + 10;
      statusMark(heroTier.status, x + HERO.w - tw, y + 1, { w: tw + 4 });
    }
    y += 28;
  }

  // Whole-listing estimate per scope
  y += 18;
  label("Estimated cost for the whole listing", M, y);
  y += 14;
  if (tiers.length) {
    const gap = 10;
    const cw = (W - gap * (tiers.length - 1)) / tiers.length;
    const cardH = 92;
    tiers.forEach((tier, i) => {
      const x = M + i * (cw + gap);
      const x0 = x + 14;
      const iw = cw - 28;
      const t = totals.get(tier);
      const c = tally(tier);
      doc.roundedRect(x, y, cw, cardH, 8).fill(tier === preferred ? C.primarySoft : C.soft);
      write(tierName(tier), x0, y + 13, iw, { font: "bold", size: 11 });
      write(TIER_LABELS[tier].blurb, x0, y + 28, iw, { size: 8, color: C.muted });
      write(t ? formatRange(t.range) : "No estimate", x0, y + 44, iw, { font: "medium", size: 17, color: t ? C.text : C.muted });
      const sub = [t ? `${t.rooms} ${t.rooms === 1 ? "room" : "rooms"}` : null, `${c.verified} of ${c.total} verified`].filter(Boolean).join(" · ");
      write(sub, x0, y + 70, iw, { size: 8, color: C.muted });
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

  // Status legend
  y += 14;
  const legend = ["verified", "review", "failed"] as const;
  const lw = (W - 20) / legend.length;
  const legendH = Math.max(...legend.map((s) => measure(STATUS[s].meaning, lw - 10, { size: 8 }))) + 14;
  ensure(legendH + 12);
  rule(y);
  y += 8;
  legend.forEach((s, i) => {
    const x = M + i * (lw + 10);
    statusMark(s, x, y, { w: lw });
    write(STATUS[s].meaning, x + 10, y + 12, lw - 10, { size: 8, color: C.muted });
  });
  y += legendH;

  /* ---------- Room by room ---------- */

  newPage();
  y += write("Room by room", M, y, W, { font: "bold", size: 14 });
  y += 4;
  y += write(
    preferred
      ? `Each room's listing photo next to its redesign (${tierName(preferred)} where it held up, otherwise the next best), with the estimate at every scope.`
      : "Each room's listing photo with the estimate at every scope.",
    M,
    y,
    W,
    { size: 9, color: C.muted },
  );
  y += 14;

  const col = { before: M, after: M + THUMB.w + 6, room: M + THUMB.w * 2 + 18 };
  const roomW = 104;
  const tiersX = col.room + roomW + 8;
  const tierW = (M + W - tiersX) / Math.max(1, tiers.length);
  const tableHead = () => {
    label("Listing", col.before, y, THUMB.w);
    label("Redesign", col.after, y, THUMB.w);
    label("Room", col.room, y, roomW);
    tiers.forEach((t, i) => label(tierName(t), tiersX + i * tierW, y, tierW - 6));
    y += 13;
    rule(y, M, W, C.text);
    y += 8;
  };
  tableHead();
  for (const p of photos) {
    const shown = showcase(p, preferred);
    const nameH = measure(roomName(p), roomW, { font: "bold", size: 9.5 });
    const rowH = Math.max(THUMB.h, nameH + 14) + 16;
    if (y + rowH > BOTTOM) {
      newPage();
      tableHead();
    }
    picture(p.original, THUMB, col.before, y);
    picture(shown?.image ?? null, THUMB, col.after, y, "None");
    const nh = write(roomName(p), col.room, y + 1, roomW, { font: "bold", size: 9.5 });
    if (shown) write(`Shown: ${tierName(shown.tier)}`, col.room, y + nh + 3, roomW, { size: 8, color: C.muted });
    tiers.forEach((tier, i) => {
      const x = tiersX + i * tierW;
      const t = p.tiers.find((r) => r.tier === tier);
      if (!t) return write("Not run", x, y + 1, tierW - 6, { size: 8.5, color: C.muted });
      const cost = planCost(t.plan);
      const h = cost ? write(formatRange(cost), x, y + 1, tierW - 6, { font: "medium", size: 9.5 }) : 0;
      statusMark(t.status, x, y + h + (h ? 4 : 1), { w: tierW - 4, size: 7.5 });
    });
    y += rowH - 8;
    rule(y);
    y += 8;
  }
  if (totals.size) {
    ensure(30);
    y += 2;
    write("Whole listing", col.room, y, roomW, { font: "bold", size: 10 });
    tiers.forEach((tier, i) => {
      const t = totals.get(tier);
      write(t ? formatRange(t.range) : "–", tiersX + i * tierW, y, tierW - 6, { font: "bold", size: 10 });
    });
    y += 18;
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

  /* ---------- Full scope: a section per room ---------- */

  if (full) {
    photos.forEach((p, n) => {
      newPage();
      const room = roomName(p);
      label(`Room ${n + 1} of ${photos.length}`, M, y);
      y += 14;
      y += write(room, M, y, W, { font: "bold", size: 20, lineGap: 0 });
      y += 3;
      y += write(`Kept as is: ${fixedSummary(p) || "nothing structural detected"}`, M, y, W, { size: 8.5, color: C.muted });
      y += 12;

      // Listing photo with what the photo shows about the room today.
      const sideX = M + ROOM_IMG.w + 16;
      const sideW = W - ROOM_IMG.w - 16;
      const top = y;
      picture(p.original, ROOM_IMG, M, y);
      write("Listing photo", M, y + ROOM_IMG.h + 5, ROOM_IMG.w, { size: 8, color: C.muted });
      let sy = top;
      sy += write("The room today", sideX, sy, sideW, { font: "bold", size: 10 });
      sy += 4;
      if (p.inventory.condition) sy += write(sentence(p.inventory.condition), sideX, sy, sideW, { size: 9, lineGap: 2 }) + 8;
      if (p.inventory.uncertainties.length) {
        sy += write("Can't tell from this photo", sideX, sy, sideW, { font: "medium", size: 8.5, color: C.muted });
        sy += 3;
        for (const u of p.inventory.uncertainties.slice(0, 5)) {
          const h = measure(u, sideW - 10, { size: 8.5 });
          if (sy + h > top + ROOM_IMG.h + 60) break;
          write("•", sideX, sy, 8, { size: 8.5, color: C.faint });
          write(u, sideX + 10, sy, sideW - 10, { size: 8.5 });
          sy += h + 2;
        }
      }
      y = Math.max(top + ROOM_IMG.h + 18, sy);

      for (const t of p.tiers) {
        const total = planCost(t.plan);
        ensure(ROOM_IMG.h + 70);
        y += 22;
        // Scope header: name and blurb on the left, the room's estimate on the right.
        write(tierName(t.tier), M, y, W, { font: "bold", size: 13 });
        style({ font: "bold", size: 13 });
        const nw = doc.widthOfString(tierName(t.tier));
        write(TIER_LABELS[t.tier].blurb, M + nw + 8, y + 3.5, W - nw - 120, { size: 8.5, color: C.muted });
        if (total) write(formatRange(total), M, y, W, { font: "medium", size: 13, align: "right" });
        y += 19;
        rule(y, M, W, C.text);
        y += 10;

        const blockTop = y;
        picture(t.image, ROOM_IMG, M, y, `${STATUS[t.status].label}. ${STATUS[t.status].meaning}.`);
        let ry = blockTop;
        ry += statusMark(t.status, sideX, ry, { size: 9, meaning: true, w: sideW }) + 6;
        const direction = [t.plan.expression && sentence(t.plan.expression), t.plan.architecturalLanguage].filter(Boolean).join(" · ");
        if (direction) ry += write(direction, sideX, ry, sideW, { size: 8.5, color: C.muted, lineGap: 2 }) + 8;
        const reasons = t.reasons.map(plainReason);
        if (reasons.length) {
          ry += write("What to check", sideX, ry, sideW, { font: "medium", size: 8.5 });
          ry += 3;
          for (const r of reasons.slice(0, 4)) {
            const h = measure(r, sideW - 10, { size: 8 });
            if (ry + h > blockTop + ROOM_IMG.h) break;
            write("•", sideX, ry, 8, { size: 8, color: C.faint });
            write(r, sideX + 10, ry, sideW - 10, { size: 8, color: C.muted });
            ry += h + 2;
          }
        }
        const openings = t.edges.length ? `${t.edges.filter((e) => e.pass).length} of ${t.edges.length} window and door outlines match` : null;
        const fine = [openings, t.judgement ? `plan followed ${t.judgement.planAdherence}/10` : null].filter(Boolean).join(" · ");
        if (fine && ry + 12 <= blockTop + ROOM_IMG.h) write(sentence(fine), sideX, blockTop + ROOM_IMG.h - 10, sideW, { size: 7.5, color: C.faint });
        y = Math.max(blockTop + ROOM_IMG.h, ry) + 14;

        // Every planned change, with what it replaces and how it was priced.
        const changes = t.plan.changes;
        if (changes.length) {
          ensure(40);
          label(`Planned changes (${changes.length})`, M, y);
          y += 14;
          const textW = W - 96;
          for (const c of changes) {
            const basis = c.costBasis ? `${c.costSource === "estimate" ? "Model estimate, not from the cost table: " : ""}${c.costBasis}` : "";
            const h =
              measure(sentence(c.element), textW, { font: "bold", size: 9.5 }) +
              measure(c.proposed, textW, { size: 9 }) +
              measure(`Now: ${c.current}`, textW, { size: 8.5 }) +
              (basis ? measure(basis, textW, { size: 8 }) + 2 : 0) +
              16;
            ensure(h);
            let cy = y;
            cy += write(sentence(c.element), M, cy, textW, { font: "bold", size: 9.5 }) + 1;
            if (Number.isFinite(c.costLow) && Number.isFinite(c.costHigh)) {
              write(formatRange({ low: Math.min(c.costLow, c.costHigh), high: Math.max(c.costLow, c.costHigh) } satisfies CostRange), M + W - 90, y, 90, { font: "medium", size: 9.5, align: "right" });
            }
            cy += write(c.proposed, M, cy, textW, { size: 9 });
            cy += write(`Now: ${c.current}`, M, cy + 1, textW, { size: 8.5, color: C.muted }) + 1;
            if (basis) cy += write(basis, M, cy + 1, textW, { size: 8, color: C.faint }) + 2;
            y = cy + 7;
            rule(y);
            y += 8;
          }
        }
        const extra: Array<[string, string[]]> = [
          ["Walls removed", t.plan.removedWalls],
          ["For the full look, beyond this scope", t.plan.beyondScope ?? []],
          ["Check with a contractor", t.plan.feasibilityFlags],
        ];
        for (const [title, items] of extra) {
          if (!items.length) continue;
          ensure(36);
          y += 4;
          y += write(title, M, y, W, { font: "medium", size: 9, color: C.muted });
          y += 4;
          bullets(items, M, W, { size: 9 });
          y += 4;
        }
      }
    });
  }

  /* ---------- Footer on every page ---------- */

  const range = doc.bufferedPageRange();
  const footer = `${input.title} · ${PDF_DETAIL_LABELS[detail]}${dateText ? ` · ${dateText}` : ""}`;
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0; // writing below the bottom margin would otherwise start a new page
    rule(PAGE.h - 44);
    write(footer, M, PAGE.h - 36, W - 80, { size: 7.5, color: C.faint });
    write(`${i - range.start + 1} of ${range.count}`, M + W - 80, PAGE.h - 36, 80, { size: 7.5, color: C.faint, align: "right" });
  }

  doc.end();
  return done;
}

/** "Maple St – Remodel summary.pdf", safe for a Content-Disposition header. */
export function pdfFilename(title: string, detail: PdfDetail): string {
  const base = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "Listing";
  return `${base} - Remodel ${detail === "full" ? "full scope" : "summary"}.pdf`;
}
