import { afterAll, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const { root } = await vi.hoisted(async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  return { root: await mkdtemp(join(tmpdir(), "listing-sort-")) };
});
vi.mock("../src/config.js", async (original) => ({ ...(await original<object>()), ROOT: root }));
const store = await import("../src/listing/listing.js");
const { keepInteriorPhotos } = await import("../src/listing/sort.js");
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

const photo = (dir: string, name: string) => sharp({ create: { width: 64, height: 48, channels: 3, background: "#888" } }).jpeg().toFile(path.join(dir, name));

const KINDS: Record<string, [string, string]> = { "01.jpg": ["exterior", "other room"], "02.jpg": ["interior", "kitchen"], "03.jpg": ["interior", "living room"], "04.jpg": ["floor_plan", "other room"], "05.jpg": ["interior", "other room"] };

async function fiveRooms(name: string) {
  const listing = await store.createListing({ name });
  for (const file of Object.keys(KINDS)) await photo(listing.dir, file);
  await store.saveSelection(listing.dir, [{ file: "02.jpg", room: "chef's kitchen" }]);
  return listing;
}

it("asks the Decisions API about each photo, keeps interiors with room names and skips exteriors and floor plans", async () => {
  process.env.OPENAI_API_KEY = "test";
  const listing = await fiveRooms("Decided");
  const order = Object.values(KINDS);
  let n = 0;
  const bodies: Array<{ model: string; questions: Array<{ name: string }>; input: Array<{ content: Array<{ type: string; image_url?: string }> }> }> = [];
  const fetchFn = (async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    const [kind, room] = order[n++]!;
    return new Response(JSON.stringify({ answers: [{ type: "choice", name: "kind", choice: kind }, { type: "choice", name: "room", choice: room }] }));
  }) as never;

  const result = await keepInteriorPhotos(listing.dir, "openai/test", { fetch: fetchFn });
  expect(bodies).toHaveLength(5);
  expect(bodies[0]).toMatchObject({ model: "gpt-6-luna", questions: [{ name: "kind" }, { name: "room" }, { name: "quality" }, { name: "cover" }] });
  expect(bodies[0]!.input[0]!.content[1]!.image_url).toMatch(/^data:image\/jpeg;base64,/);
  expect(result).toMatchObject({ kept: 3, skipped: 2 });
  // A typed room name wins over the guess.
  expect((await store.readListing(listing.dir)).photos).toEqual([
    { file: "01.jpg", room: "", selected: false },
    { file: "02.jpg", room: "chef's kitchen", selected: true },
    { file: "03.jpg", room: "living room", selected: true },
    { file: "04.jpg", room: "", selected: false },
    { file: "05.jpg", room: "", selected: true },
  ]);
});

it("falls back to the vision model when the Decisions API fails, keeping photos it didn't mention", async () => {
  const listing = await fiveRooms("Fallback");
  const fetchFn = (async () => new Response("not found", { status: 404 })) as never;
  const calls: Array<{ prompt: string; images: number }> = [];
  const generate = (async (input: { prompt: string; images?: unknown[] }) => {
    calls.push({ prompt: input.prompt, images: input.images?.length ?? 0 });
    return { photos: [
      { id: "photo_1", kind: "exterior", room: "" },
      { id: "photo_2", kind: "interior", room: "kitchen" },
      { id: "Photo_3", kind: "interior", room: "living room" },
      { id: "photo_4", kind: "floor_plan", room: "" },
    ] };
  }) as never;
  const result = await keepInteriorPhotos(listing.dir, "openai/test", { fetch: fetchFn, generate });
  expect(calls).toEqual([{ prompt: expect.stringContaining("photo_1, photo_2, photo_3, photo_4, photo_5"), images: 5 }]);
  expect(result).toMatchObject({ kept: 3, skipped: 2 });
  expect((await store.readListing(listing.dir)).photos.map((p) => p.selected)).toEqual([false, true, true, false, true]);
});

it("refuses a listing with no interior photos", async () => {
  const listing = await store.createListing({ name: "Yard only" });
  await photo(listing.dir, "yard.jpg");
  const fetchFn = (async () => new Response(JSON.stringify({ answers: [{ type: "choice", name: "kind", choice: "exterior" }] }))) as never;
  await expect(keepInteriorPhotos(listing.dir, "openai/test", { fetch: fetchFn })).rejects.toThrow(/No interior photos/);
  expect((await store.readListing(listing.dir)).photos[0]!.selected).toBe(true);
});

it("flags poor photos without deselecting interiors and respects manual cover choices", async () => {
  process.env.OPENAI_API_KEY = "test";
  const listing = await fiveRooms("Quality and cover");
  let n = 0;
  const fetchFn = (async () => {
    const i = n++ % 5;
    const [kind, room] = Object.values(KINDS)[i]!;
    return new Response(JSON.stringify({ answers: [
      { type: "choice", name: "kind", choice: kind },
      { type: "choice", name: "room", choice: room },
      { type: "choice", name: "quality", choice: i === 1 ? "blurred" : "usable", confidence: 0.97 },
      { type: "score", name: "cover", score: i === 1 ? 3 : i === 2 ? 2.8 : 0 },
    ] }));
  }) as never;
  const result = await keepInteriorPhotos(listing.dir, "openai/test", { fetch: fetchFn });
  expect(result.listing.thumbnail).toBe("03.jpg");
  expect(result.listing.photos[1]).toMatchObject({ selected: true, quality: "Severe blur" });
  await store.saveSelection(listing.dir, [{ file: "02.jpg", room: "My kitchen" }]);
  expect((await store.readListing(listing.dir)).photos[1]!.quality).toBe("Severe blur");
  await store.setListingThumbnail(listing.dir, "01.jpg");
  expect((await keepInteriorPhotos(listing.dir, "openai/test", { fetch: fetchFn })).listing.thumbnail).toBe("01.jpg");
});

it("quality assessment preserves manual photo selections", async () => {
  const listing = await fiveRooms("Manual selections");
  await store.saveSelection(listing.dir, [{ file: "01.jpg", selected: true }, { file: "02.jpg", selected: false }]);
  const fetchFn = (async () => new Response(JSON.stringify({ answers: [
    { type: "choice", name: "kind", choice: "interior" },
    { type: "choice", name: "room", choice: "living room" },
  ] }))) as never;
  await keepInteriorPhotos(listing.dir, "openai/test", { fetch: fetchFn, interiorsOnly: false });
  expect((await store.readListing(listing.dir)).photos.map(p => p.selected)).toEqual([true, false, true, true, true]);
});
