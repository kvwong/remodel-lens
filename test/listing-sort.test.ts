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

it("keeps interiors selected with room names and skips exteriors and floor plans", async () => {
  const listing = await store.createListing({ name: "Sorted" });
  for (const name of ["01.jpg", "02.jpg", "03.jpg", "04.jpg", "05.jpg"]) await photo(listing.dir, name);
  await store.saveSelection(listing.dir, [{ file: "02.jpg", room: "chef's kitchen" }]);
  const calls: Array<{ prompt: string; images: number }> = [];
  const generate = vi.fn(async (input: { prompt: string; images?: unknown[] }) => {
    calls.push({ prompt: input.prompt, images: input.images?.length ?? 0 });
    return { photos: [
      { id: "photo_1", kind: "exterior", room: "" },
      { id: "photo_2", kind: "interior", room: "kitchen" },
      { id: "Photo_3", kind: "interior", room: "living room" },
      { id: "photo_4", kind: "floor_plan", room: "" },
    ] };
  }) as never;

  const result = await keepInteriorPhotos(listing.dir, "openai/test", generate);
  expect(calls).toEqual([{ prompt: expect.stringContaining("photo_1, photo_2, photo_3, photo_4, photo_5"), images: 5 }]);
  expect(result).toMatchObject({ kept: 3, skipped: 2 });
  // A typed room name wins; photo 5 wasn't mentioned, so it stays in rather than silently dropping.
  expect((await store.readListing(listing.dir)).photos).toEqual([
    { file: "01.jpg", room: "", selected: false },
    { file: "02.jpg", room: "chef's kitchen", selected: true },
    { file: "03.jpg", room: "living room", selected: true },
    { file: "04.jpg", room: "", selected: false },
    { file: "05.jpg", room: "", selected: true },
  ]);
});

it("refuses a listing with no interior photos", async () => {
  const listing = await store.createListing({ name: "Yard only" });
  await photo(listing.dir, "yard.jpg");
  const generate = (async () => ({ photos: [{ id: "photo_1", kind: "exterior", room: "" }] })) as never;
  await expect(keepInteriorPhotos(listing.dir, "openai/test", generate)).rejects.toThrow(/No interior photos/);
  expect((await store.readListing(listing.dir)).photos[0]!.selected).toBe(true);
});
