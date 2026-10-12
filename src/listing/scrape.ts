// Pull a listing's photos from a Redfin, Zillow, or Compass page, or from a street address.
// Pages are fetched with plain HTTP from this machine, so a site's bot protection can refuse them;
// when a page is refused, the address in its link is looked up on the other sites instead.
import { log, mapLimit } from "../files.js";

export type Site = "redfin" | "zillow" | "compass" | "other";
export const SITE_NAMES: Record<Site, string> = { redfin: "Redfin", zillow: "Zillow", compass: "Compass", other: "Listing page" };

/** One listing photo: URLs to try in order, best quality first. */
export type PhotoSource = { candidates: string[] };
export type ParsedPage = { site: Site; url: string; street: string | null; locality: string | null; photos: PhotoSource[] };
type Fetch = typeof fetch;

const HEADERS = {
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
};
const PAGE_TIMEOUT = 20_000;

export function siteOf(url: string): Site {
  const host = new URL(url).hostname.replace(/^www\./, "");
  if (host === "redfin.com" || host.endsWith(".redfin.com")) return "redfin";
  if (host === "zillow.com" || host.endsWith(".zillow.com")) return "zillow";
  if (host === "compass.com" || host.endsWith(".compass.com")) return "compass";
  return "other";
}

/** A pasted link, with or without https://; anything else is treated as an address. */
export function asUrl(input: string): string | null {
  const text = input.trim();
  if (/\s/.test(text)) return null;
  const withScheme = /^https?:\/\//i.test(text) ? text : /^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+\//i.test(text) ? `https://${text}` : null;
  if (!withScheme) return null;
  try {
    return new URL(withScheme).toString();
  } catch {
    return null;
  }
}

/** Page data often carries URLs inside JSON strings: undo \/, / and \" escaping so one regex sees them all. */
export function unescapePage(html: string): string {
  return html
    .replace(/\\+u002[fF]/g, "/")
    .replace(/\\+\//g, "/")
    .replace(/\\+"/g, '"')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

function meta(html: string, property: string): string | null {
  const tag = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]*>`, "i"))?.[0];
  return tag?.match(/content=["']([^"']*)["']/i)?.[1]?.trim() || null;
}

/** "709 143rd Ave NE Unit G-25, Bellevue, WA 98007 - 3 beds" → street and "Bellevue, WA". */
export function splitAddress(title: string | null): { street: string | null; locality: string | null } {
  const address = title?.split(/\s+[|–-]\s+/)[0]?.trim();
  const parts = address?.split(",").map((part) => part.trim()).filter(Boolean) ?? [];
  if (parts.length < 2 || !/\d/.test(parts[0]!)) return { street: null, locality: null };
  const state = parts[2]?.match(/^([A-Z]{2})\b/)?.[1];
  return { street: parts[0]!, locality: state ? `${parts[1]}, ${state}` : parts[1]! };
}

/** The bracketed JSON value that follows "key": in page data, or null. Brackets inside strings are rare enough to ignore. */
function arrayAfter(text: string, key: string): string | null {
  const start = text.indexOf(`"${key}"`);
  if (start < 0) return null;
  const open = text.indexOf("[", start);
  if (open < 0 || open - start > key.length + 8) return null;
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "[") depth += 1;
    else if (text[i] === "]" && --depth === 0) return text.slice(open, i + 1);
  }
  return null;
}

const unique = <T>(items: T[]) => [...new Set(items)];

// Redfin photo URLs: /photo/<source>/<kind>/<last 3>/[genMid.]<mls>_<n>[_<rev>].jpg. Photo 0 has no rev; the
// listing's own photos share the og:image's MLS key, while nearby and sold homes on the page use other keys.
const REDFIN_PHOTO = /https?:\/\/ssl\.cdn-redfin\.com\/photo\/(\d+)\/([a-z0-9]+)\/(\w+)\/(?:gen[A-Za-z]+\.)?([A-Za-z0-9]+)_(\d+)(?:_(\d+))?\.(?:jpg|jpeg|webp|png)/g;

function parseRedfin(page: string, ogImage: string | null): PhotoSource[] {
  const seen = [...page.matchAll(REDFIN_PHOTO)].map((m) => ({
    url: m[0], source: m[1]!, dir: m[3]!, key: m[4]!, index: m[6] === undefined ? 0 : Number(m[5]), rev: m[6] ?? null,
  }));
  if (!seen.length) return [];
  const fromOg = ogImage ? [...ogImage.matchAll(REDFIN_PHOTO)][0]?.[4] : undefined;
  const counts = new Map<string, number>();
  for (const s of seen) counts.set(s.key, (counts.get(s.key) ?? 0) + 1);
  const key = fromOg && counts.has(fromOg) ? fromOg : [...counts].sort((a, b) => b[1] - a[1])[0]![0];
  const own = seen.filter((s) => s.key === key);
  const { source, dir } = own[0]!;
  // The page shows only some thumbnails, but the full set follows the same numbering up to the photo count.
  const count = Number(page.match(/"photoCount"\s*:\s*(\d+)/)?.[1] ?? page.match(/(\d+)\s+photos\b/i)?.[1] ?? 0);
  const total = Math.min(Math.max(count, ...own.map((s) => s.index + 1)), 80);
  const photos: PhotoSource[] = [];
  for (let index = 0; index < total; index += 1) {
    const mine = own.filter((s) => s.index === index);
    const rev = mine.find((s) => s.rev !== null)?.rev ?? "0";
    const big = `https://ssl.cdn-redfin.com/photo/${source}/bigphoto/${dir}/${key}_${index === 0 ? "0" : `${index}_${rev}`}.jpg`;
    // Prefer bigger observed renditions as fallbacks when bigphoto isn't there.
    const rank = (url: string) => (/bigphoto/.test(url) ? 0 : /mbphotov3|mbpaddedwide/.test(url) ? 1 : 2);
    photos.push({ candidates: unique([big, ...mine.map((s) => s.url).sort((a, b) => rank(a) - rank(b))]) });
  }
  return photos;
}

// Zillow photo URLs: photos.zillowstatic.com/fp/<hash>-<size>.jpg. The listing's own set is under
// "responsivePhotos" (or "photos") in the page data; nearby homes and MLS logos use other hashes.
const ZILLOW_PHOTO = /https?:\/\/photos\.zillowstatic\.com\/fp\/([0-9a-f]{32})-([A-Za-z0-9_]+)\.(?:jpg|jpeg|webp|png)/g;

function parseZillow(page: string, ogImage: string | null): PhotoSource[] {
  const scope = arrayAfter(page, "responsivePhotos") ?? arrayAfter(page, "originalPhotos") ?? arrayAfter(page, "photos") ?? page;
  let hashes = unique([...scope.matchAll(ZILLOW_PHOTO)].filter((m) => !/logo|zillow_web/i.test(m[2]!)).map((m) => m[1]!));
  const cover = ogImage ? [...ogImage.matchAll(ZILLOW_PHOTO)][0]?.[1] : undefined;
  if (scope === page && cover) hashes = unique([cover, ...hashes.filter((h) => h === cover)]); // no photo list: only the cover is safe
  return hashes.map((hash) => ({
    candidates: ["uncropped_scaled_within_1536_1152.jpg", "cc_ft_1536.jpg", "o_a.jpg"].map((size) => `https://photos.zillowstatic.com/fp/${hash}-${size}`),
  }));
}

// Compass photo URLs: compass.com/m/<listing key>_img_<n>_<hash>/<size>.jpg; origin is the full upload.
const COMPASS_PHOTO = /https?:\/\/(?:www\.)?compass\.com\/m\/(?:\d+\/)?([0-9a-f]{16,})_img_(\d+)_([0-9a-z]+)\/[A-Za-z0-9x.]+?\.(?:jpg|jpeg|webp|png)/g;

function parseCompass(page: string, ogImage: string | null): PhotoSource[] {
  const seen = [...page.matchAll(COMPASS_PHOTO)].map((m) => ({ key: m[1]!, index: Number(m[2]), hash: m[3]!, base: m[0].replace(/\/[^/]+$/, "") }));
  if (!seen.length) return [];
  const fromOg = ogImage ? [...ogImage.matchAll(COMPASS_PHOTO)][0]?.[1] : undefined;
  const counts = new Map<string, number>();
  for (const s of seen) counts.set(s.key, (counts.get(s.key) ?? 0) + 1);
  const key = fromOg && counts.has(fromOg) ? fromOg : [...counts].sort((a, b) => b[1] - a[1])[0]![0];
  const byIndex = new Map<number, string>();
  for (const s of seen) if (s.key === key && !byIndex.has(s.index)) byIndex.set(s.index, s.base);
  return [...byIndex].sort((a, b) => a[0] - b[0]).map(([, base]) => ({ candidates: [`${base}/origin.jpg`, `${base}/origin.webp`, `${base}/1500x1000.jpg`] }));
}

/** Other brokerages: schema.org images, else the share image. */
function parseOther(page: string, ogImage: string | null): PhotoSource[] {
  const fromLd = [...page.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].flatMap((m) => {
    const images: string[] = [];
    const walk = (value: unknown, key = "") => {
      if (typeof value === "string" && /^(image|photo|contentUrl|url)$/i.test(key) && /^https?:\/\/.+\.(jpe?g|webp|png)(\?|$)/i.test(value)) images.push(value);
      else if (Array.isArray(value)) value.forEach((item) => walk(item, key));
      else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) walk(v, /^(image|photo)$/i.test(key) && k === "url" ? key : k);
    };
    try { walk(JSON.parse(m[1]!)); } catch { /* not JSON */ }
    return images;
  });
  return unique(fromLd.length ? fromLd : ogImage ? [ogImage] : []).map((url) => ({ candidates: [url] }));
}

export function parseListingPage(url: string, html: string): ParsedPage {
  const site = siteOf(url);
  const page = unescapePage(html);
  const ogImage = meta(html, "og:image");
  const title = meta(html, "og:title") ?? html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? null;
  const photos = site === "redfin" ? parseRedfin(page, ogImage) : site === "zillow" ? parseZillow(page, ogImage) : site === "compass" ? parseCompass(page, ogImage) : parseOther(page, ogImage);
  return { site, url, ...splitAddress(title ? unescapePage(title) : null), photos };
}

/** Address words from a listing link, e.g. zillow.com/homedetails/3630-122nd-Pl-NE-Bellevue-WA-98005/… */
export function addressFromUrl(url: string): string | null {
  const parts = new URL(url).pathname.split("/").filter(Boolean);
  const site = siteOf(url);
  const slug = site === "zillow" ? parts[parts.indexOf("homedetails") + 1]
    : site === "compass" ? parts[parts.indexOf("listing") + 1]
    : site === "redfin" ? [parts[2], parts[3]?.startsWith("unit-") ? parts[3] : null, parts[1]].filter(Boolean).join("-")
    : null;
  if (!slug || !/^\d/.test(slug) || /^restricted-address/.test(slug)) return null;
  return decodeURIComponent(slug).replace(/-/g, " ").replace(/\bunit\b/i, "Unit");
}

async function fetchPage(url: string, fetchFn: Fetch): Promise<{ url: string; html: string | null; status: number }> {
  try {
    const res = await fetchFn(url, { headers: HEADERS, redirect: "follow", signal: AbortSignal.timeout(PAGE_TIMEOUT) });
    const html = await res.text();
    const blocked = !res.ok || /px-captcha|captcha-delivery|cf-chl|Access to this page has been denied|Press &amp; Hold|are you a human/i.test(html);
    return { url: res.url || url, html: blocked ? null : html, status: res.status };
  } catch (error) {
    log(`${new URL(url).hostname}: ${error instanceof Error ? error.message : String(error)}`);
    return { url, html: null, status: 0 };
  }
}

/** Find a for-sale or recently sold listing page for a street address. Redfin's search box first, then Zillow's. */
export async function findListingUrl(address: string, fetchFn: Fetch = fetch, skip: Site[] = []): Promise<string | null> {
  if (!skip.includes("redfin")) {
    try {
      const res = await fetchFn(`https://www.redfin.com/stingray/do/location-autocomplete?location=${encodeURIComponent(address)}&v=2`, { headers: { ...HEADERS, accept: "application/json" }, signal: AbortSignal.timeout(PAGE_TIMEOUT) });
      if (res.ok) {
        const body = JSON.parse((await res.text()).replace(/^\{\}&&/, ""));
        const rows = [body.payload?.exactMatch, ...(body.payload?.sections ?? []).flatMap((s: { rows?: unknown[] }) => s.rows ?? [])];
        const home = rows.find((row) => typeof row?.url === "string" && row.url.includes("/home/"));
        if (home) return new URL(home.url, "https://www.redfin.com").toString();
      }
    } catch (error) {
      log(`Redfin search: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!skip.includes("zillow")) {
    // Zillow redirects an exact address search straight to the home's page.
    const slug = address.trim().replace(/[#,]/g, " ").replace(/\s+/g, "-");
    const page = await fetchPage(`https://www.zillow.com/homes/${encodeURIComponent(slug)}_rb/`, fetchFn);
    if (page.url.includes("/homedetails/")) return page.url;
  }
  return null;
}

export type ScrapeResult = ParsedPage & { refused: string[] };

/** Resolve a link or address to a listing page and read its photos. Throws a message fit to show. */
export async function scrapeListing(input: string, fetchFn: Fetch = fetch): Promise<ScrapeResult> {
  const text = input.trim();
  if (!text) throw Object.assign(new Error("Paste a listing link or an address."), { status: 400 });
  const link = asUrl(text);
  const refused: string[] = [];
  const tried = new Set<string>();

  const read = async (url: string): Promise<ParsedPage | null> => {
    if (tried.has(url)) return null;
    tried.add(url);
    log(`Reading ${url}`);
    const page = await fetchPage(url, fetchFn);
    if (!page.html) {
      refused.push(`${SITE_NAMES[siteOf(url)]} ${page.status ? `refused the request (${page.status})` : "didn't respond"}`);
      return null;
    }
    const parsed = parseListingPage(page.url, page.html);
    if (!parsed.photos.length) refused.push(`${SITE_NAMES[parsed.site]} page had no listing photos`);
    return parsed.photos.length ? parsed : null;
  };

  if (link) {
    const direct = await read(link);
    if (direct) return { ...direct, refused };
    // The page was refused or empty: look the same home up on the other sites by the address in its link.
    const address = addressFromUrl(link);
    if (address) {
      const other = await findListingUrl(address, fetchFn, [siteOf(link)]);
      const found = other ? await read(other) : null;
      if (found) return { ...found, refused };
    }
    const tryNext = siteOf(link) === "redfin" ? "its street address" : "the same home's Redfin link or its street address";
    throw Object.assign(new Error(`Couldn't get photos from that link: ${refused.join("; ")}. Try ${tryNext}, or add the photos yourself.`), { status: 502 });
  }

  const url = await findListingUrl(text, fetchFn);
  if (!url) throw Object.assign(new Error("Couldn't find a listing for that address on Redfin or Zillow. Check the address, or paste the listing link."), { status: 404 });
  const found = await read(url);
  if (found) return { ...found, refused };
  throw Object.assign(new Error(`Found ${url} but couldn't get its photos: ${refused.join("; ")}.`), { status: 502 });
}

/** Download each photo, trying its candidates in order. Missing photos come back null. */
export async function downloadPhotos(photos: PhotoSource[], referer: string, fetchFn: Fetch = fetch, concurrency = 6): Promise<Array<Buffer | null>> {
  let done = 0;
  return mapLimit(photos, concurrency, async (photo) => {
    for (const url of photo.candidates) {
      try {
        const res = await fetchFn(url, { headers: { ...HEADERS, accept: "image/avif,image/webp,image/jpeg,image/*;q=0.8", referer }, signal: AbortSignal.timeout(PAGE_TIMEOUT) });
        if (!res.ok || !(res.headers.get("content-type") ?? "image/").startsWith("image/")) continue;
        const bytes = Buffer.from(await res.arrayBuffer());
        if (bytes.length < 2_000) continue; // placeholders and tracking pixels
        log(`Downloaded photo ${++done} of ${photos.length}`);
        return bytes;
      } catch { /* try the next size */ }
    }
    return null;
  });
}
