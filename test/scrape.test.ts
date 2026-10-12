import { afterAll, expect, it, vi } from "vitest";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const { root } = await vi.hoisted(async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  return { root: await mkdtemp(join(tmpdir(), "listing-scrape-")) };
});
vi.mock("../src/config.js", async (original) => ({ ...(await original<object>()), ROOT: root }));
const { addressFromUrl, asUrl, parseListingPage, scrapeListing, splitAddress } = await import("../src/listing/scrape.js");
const store = await import("../src/listing/listing.js");
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

// URL shapes copied from live pages (Oct 2026); the surrounding markup is trimmed down.
const REDFIN_URL = "https://www.redfin.com/WA/Bellevue/709-143rd-Ave-NE-98007/unit-G25/home/597";
const redfinPage = `<html><head>
<meta property="og:title" content="709 143rd Ave NE Unit G-25, Bellevue, WA 98007 - 3 beds/2 baths">
<meta property="og:image" content="https://ssl.cdn-redfin.com/photo/1/bigphoto/288/2588288_0.jpg">
</head><body>
<img src="https://ssl.cdn-redfin.com/photo/1/mbpaddedwide/288/genMid.2588288_0.jpg">
<img src="https://ssl.cdn-redfin.com/photo/1/mbpaddedwide/288/genMid.2588288_1_0.jpg">
<img src="https://ssl.cdn-redfin.com/photo/1/mbphotov3/288/genMid.2588288_5_2.jpg">
<script>window.__data = {"photoCount":8,"url":"https:\\/\\/ssl.cdn-redfin.com\\/photo\\/1\\/midphoto\\/288\\/genMid.2588288_7_0.jpg"};</script>
<div class="comps"><img src="https://ssl.cdn-redfin.com/photo/1/bcsphoto/448/genBcs.2526448_0.jpg"><img src="https://ssl.cdn-redfin.com/photo/1/bcsphoto/448/genBcs.2526448_1_0.jpg"></div>
</body></html>`;

it("reads every Redfin photo up to the photo count at full size, leaving out nearby homes", () => {
  const page = parseListingPage(REDFIN_URL, redfinPage);
  expect(page).toMatchObject({ site: "redfin", street: "709 143rd Ave NE Unit G-25", locality: "Bellevue, WA" });
  expect(page.photos).toHaveLength(8);
  expect(page.photos.map((p) => p.candidates[0])).toEqual([
    "https://ssl.cdn-redfin.com/photo/1/bigphoto/288/2588288_0.jpg",
    ...[1, 2, 3, 4].map((n) => `https://ssl.cdn-redfin.com/photo/1/bigphoto/288/2588288_${n}_0.jpg`),
    "https://ssl.cdn-redfin.com/photo/1/bigphoto/288/2588288_5_2.jpg",
    "https://ssl.cdn-redfin.com/photo/1/bigphoto/288/2588288_6_0.jpg",
    "https://ssl.cdn-redfin.com/photo/1/bigphoto/288/2588288_7_0.jpg",
  ]);
  expect(page.photos[1]!.candidates).toContain("https://ssl.cdn-redfin.com/photo/1/mbpaddedwide/288/genMid.2588288_1_0.jpg");
  expect(page.photos.flatMap((p) => p.candidates).some((url) => url.includes("2526448"))).toBe(false);
});

it("reads Zillow's own photo list from escaped page data, not nearby homes or MLS logos", () => {
  const photo = (hash: string, size: string) => `https:\\u002F\\u002Fphotos.zillowstatic.com\\u002Ffp\\u002F${hash}-${size}.jpg`;
  const a = "cfcfa0883336871b904f0d321f6dd2f3", b = "d7d73784909a337fa899070f570eb37d", near = "11111111111111111111111111111111";
  const html = `<meta property="og:title" content="3630 122nd Place NE, Bellevue, WA 98005 | MLS #2544766 | Zillow">
<meta property="og:image" content="https://photos.zillowstatic.com/fp/${a}-cc_ft_1536.jpg">
<script id="__NEXT_DATA__">{"props":{"gdpClientCache":"{\\"responsivePhotos\\":[{\\"mixedSources\\":{\\"jpeg\\":[{\\"url\\":\\"${photo(a, "cc_ft_384")}\\"},{\\"url\\":\\"${photo(a, "cc_ft_1536")}\\"}]}},{\\"mixedSources\\":{\\"jpeg\\":[{\\"url\\":\\"${photo(b, "cc_ft_768")}\\"}]}}],\\"nearbyHomes\\":[{\\"url\\":\\"${photo(near, "p_e")}\\"}]}"}}</script>
<img src="https://photos.zillowstatic.com/fp/033de87a0051f29108423257c615e0b5-zillow_web_95_35.jpg">`;
  const page = parseListingPage("https://www.zillow.com/homedetails/3630-122nd-Pl-NE-Bellevue-WA-98005/49006624_zpid/", html);
  expect(page).toMatchObject({ site: "zillow", street: "3630 122nd Place NE", locality: "Bellevue, WA" });
  expect(page.photos.map((p) => p.candidates[0])).toEqual([
    `https://photos.zillowstatic.com/fp/${a}-uncropped_scaled_within_1536_1152.jpg`,
    `https://photos.zillowstatic.com/fp/${b}-uncropped_scaled_within_1536_1152.jpg`,
  ]);
});

it("reads Compass photos for the listing's own key in order, at origin size", () => {
  const key = "6577fc9499e7f57fb7e89b9adf29f602f49a8005";
  const html = `<meta property="og:title" content="9841 Belfair Ln, Bellevue, WA 98004">
<meta property="og:image" content="https://www.compass.com/m/${key}_img_0_33012/640x480.jpg">
<img src="https://www.compass.com/m/${key}_img_2_81ecf/origin.webp"><img src="https://www.compass.com/m/${key}_img_1_de98e/origin.webp">
<img src="https://www.compass.com/m/${key}_img_0_33012/origin.webp"><img src="https://www.compass.com/m/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_img_0_12345/640x480.jpg">`;
  const page = parseListingPage("https://www.compass.com/listing/9841-belfair-lane-bellevue-wa-98004/1622745193732536505/", html);
  expect(page).toMatchObject({ site: "compass", street: "9841 Belfair Ln", locality: "Bellevue, WA" });
  expect(page.photos.map((p) => p.candidates[0])).toEqual([0, 1, 2].map((n) => `https://www.compass.com/m/${key}_img_${n}_${["33012", "de98e", "81ecf"][n]}/origin.jpg`));
});

it("tells links from addresses and reads the address out of a link", () => {
  expect(asUrl("redfin.com/WA/Bellevue/709-143rd-Ave-NE-98007/home/597")).toBe("https://redfin.com/WA/Bellevue/709-143rd-Ave-NE-98007/home/597");
  expect(asUrl("709 143rd Ave NE, Bellevue")).toBeNull();
  expect(addressFromUrl("https://www.zillow.com/homedetails/3630-122nd-Pl-NE-Bellevue-WA-98005/49006624_zpid/")).toBe("3630 122nd Pl NE Bellevue WA 98005");
  expect(addressFromUrl("https://www.compass.com/listing/9841-belfair-lane-bellevue-wa-98004/1622745193732536505/")).toBe("9841 belfair lane bellevue wa 98004");
  expect(addressFromUrl(REDFIN_URL)).toBe("709 143rd Ave NE 98007 Unit G25 Bellevue");
  expect(addressFromUrl("https://compass.com/listing/restricted-address-bellevue-wa-98004/25479007554250497")).toBeNull();
  expect(splitAddress("Bellevue, WA Homes for Sale")).toEqual({ street: null, locality: null });
});

/** A fake web: Zillow refuses, Redfin's search finds the home, photos are distinct images (one repeated). */
async function fakeWeb() {
  const image = (shade: number, stripe: number) => sharp({ create: { width: 640, height: 480, channels: 3, background: { r: shade, g: 255 - shade, b: 120 } } })
    .composite([{ input: Buffer.from(`<svg width="640" height="480"><rect x="${stripe}" width="120" height="480" fill="#222"/><circle cx="${600 - stripe}" cy="240" r="90" fill="#fff"/></svg>`), left: 0, top: 0 }])
    .jpeg().toBuffer();
  const photos = new Map<string, Buffer>();
  const shades = [[10, 0], [200, 400], [10, 0], [90, 250], [160, 120]];
  for (let n = 0; n < 8; n += 1) {
    const [shade, stripe] = shades[n % shades.length]!;
    const url = `https://ssl.cdn-redfin.com/photo/1/bigphoto/288/2588288_${n === 0 ? "0" : `${n}_${n === 5 ? 2 : 0}`}.jpg`;
    if (n !== 6) photos.set(url, await image(shade!, stripe!)); // photo 6 is missing everywhere
  }
  const calls: string[] = [];
  const fetchFn = (async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("zillow.com")) return new Response("<div id='px-captcha'></div>", { status: 403 });
    if (url.includes("location-autocomplete")) return new Response(`{}&&${JSON.stringify({ payload: { sections: [{ rows: [{ url: "/WA/Bellevue/709-143rd-Ave-NE-98007/unit-G25/home/597" }] }] } })}`);
    if (url === REDFIN_URL) return Object.defineProperty(new Response(redfinPage, { headers: { "content-type": "text/html" } }), "url", { value: url });
    const bytes = photos.get(url);
    return bytes ? new Response(new Uint8Array(bytes), { headers: { "content-type": "image/jpeg" } }) : new Response("missing", { status: 404 });
  }) as typeof fetch;
  return { fetchFn, calls };
}

it("falls back to Redfin by address when Zillow refuses the link", async () => {
  const { fetchFn, calls } = await fakeWeb();
  const page = await scrapeListing("https://www.zillow.com/homedetails/709-143rd-Ave-NE-UNIT-G25-Bellevue-WA-98007/48724471_zpid/", fetchFn);
  expect(page.site).toBe("redfin");
  expect(page.refused).toEqual(["Zillow refused the request (403)"]);
  expect(calls.find((url) => url.includes("location-autocomplete"))).toContain("709%20143rd%20Ave%20NE%20Unit%20G25");
});

it("creates a listing from an address with the photos, skipping duplicates and missing ones", async () => {
  const { fetchFn } = await fakeWeb();
  const result = await store.createListingFromWeb({ link: "709 143rd Ave NE #G-25, Bellevue, WA" }, fetchFn);
  expect(result).toMatchObject({ site: "Redfin", found: 8, failed: 1 });
  expect(result.added + result.skipped).toBe(7);
  expect(result.skipped).toBe(3); // photos 2, 5 and 7 repeat photo 0
  expect(result.listing).toMatchObject({ name: "709 143rd Ave NE Unit G-25", location: "Bellevue, WA", source: "Redfin", sourceUrl: REDFIN_URL });
  expect(result.listing.photos.map((p) => p.file)).toEqual(Array.from({ length: result.added }, (_, i) => `709-143rd-ave-ne-unit-g-25-${String(i + 1).padStart(2, "0")}.jpg`));
  expect(result.listing.photos.every((p) => p.selected)).toBe(true);
  const meta = JSON.parse(await readFile(path.join(result.listing.dir, "listing.json"), "utf8"));
  expect(meta.sourceUrl).toBe(REDFIN_URL);
});

it("leaves no listing behind when a page can't be read", async () => {
  const fetchFn = (async () => new Response("blocked", { status: 403 })) as unknown as typeof fetch;
  await expect(store.createListingFromWeb({ link: "https://www.compass.com/listing/restricted-address-bellevue-wa-98004/1/" }, fetchFn)).rejects.toThrow(/Compass refused the request \(403\)/);
  expect((await store.listListings()).map((l) => l.name)).toEqual(["709 143rd Ave NE Unit G-25"]);
});
