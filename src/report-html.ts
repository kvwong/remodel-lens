import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import sharp from "sharp";

import { renderReport } from "./report.js";
import { runFile, type PdfDetail, type ReportPdfInput } from "./report-pdf.js";

/**
 * Shareable copy of a run's report as one HTML file that opens in any browser, offline.
 * Photos are embedded as WebP at screen size (1200 px wide) so a typical listing stays a few MB:
 * at full size the PNGs from the image model would make it 50-100 MB.
 */
export const SHARE_WIDTH = 1200;
const THUMB_WIDTH = 128; // the By room table's 64 px thumbnails, at 2x

const FONT_DIR = path.join(path.dirname(createRequire(import.meta.url).resolve("@fontsource/hanken-grotesk/LICENSE")), "files");
const GOOGLE_FONTS = /<link rel="preconnect" href="https:\/\/fonts\.googleapis\.com">\s*<link rel="preconnect" href="https:\/\/fonts\.gstatic\.com" crossorigin>\s*<link href="https:\/\/fonts\.googleapis\.com[^"]*" rel="stylesheet">/;

/** The report's font, embedded so the file looks the same without a connection. */
function embeddedFonts(): string {
  const faces = [400, 500, 600].map((weight) => {
    const woff2 = readFileSync(path.join(FONT_DIR, `hanken-grotesk-latin-${weight}-normal.woff2`)).toString("base64");
    return `@font-face { font-family:"Hanken Grotesk"; font-style:normal; font-weight:${weight}; font-display:swap; src:url(data:font/woff2;base64,${woff2}) format("woff2"); }`;
  });
  return `<style>${faces.join("\n")}</style>`;
}

const unescapeAttr = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const isRunPath = (s: string) => !!s && !/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(s);

export async function renderReportHtml(input: ReportPdfInput): Promise<string> {
  let html = renderReport({ title: input.title, photos: input.photos, profileSummary: input.profileSummary, location: input.location, run: input.run, share: input.detail });
  html = html.replace(GOOGLE_FONTS, embeddedFonts());

  // The viewer falls back to each thumbnail's own image, so every photo is embedded once per place it appears.
  html = html.replace(/ data-src="[^"]*"/g, "");

  const encoded = new Map<string, Promise<string | null>>();
  const encode = (rel: string, width: number) => {
    const key = `${rel}@${width}`;
    if (!encoded.has(key)) {
      const file = runFile(input.runDir, rel);
      encoded.set(key, file
        ? sharp(file).rotate().resize({ width, withoutEnlargement: true }).webp({ quality: 75 }).toBuffer()
          .then((b) => `data:image/webp;base64,${b.toString("base64")}`)
          .catch(() => null) // a missing or unreadable image shows as broken rather than failing the download
        : Promise.resolve(null));
    }
    return encoded.get(key)!;
  };

  const tags = [...html.matchAll(/<img\b[^>]*>/g)];
  const swapped = await Promise.all(tags.map(async ([tag]) => {
    const src = /\ssrc="([^"]*)"/.exec(tag)?.[1];
    if (!src || !isRunPath(unescapeAttr(src))) return tag;
    const data = await encode(unescapeAttr(src), /class="room-thumb"/.test(tag) ? THUMB_WIDTH : SHARE_WIDTH);
    return data ? tag.replace(/\ssrc="[^"]*"/, ` src="${data}"`) : tag;
  }));
  let i = 0;
  return html.replace(/<img\b[^>]*>/g, () => swapped[i++]!);
}

/** "Maple St - Remodel summary.html", safe for a Content-Disposition header. */
export function htmlFilename(title: string, detail: PdfDetail): string {
  const base = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "Listing";
  return `${base} - Remodel ${detail === "full" ? "full scope" : "summary"}.html`;
}
