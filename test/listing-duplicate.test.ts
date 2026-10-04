import { afterAll, expect, it, vi } from "vitest";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";

const { root } = await vi.hoisted(async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  return { root: await mkdtemp(join(tmpdir(), "listing-duplicate-")) };
});
vi.mock("../src/config.js", async (original) => ({ ...(await original<object>()), ROOT: root }));
const store = await import("../src/listing/listing.js");
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

it("duplicates photos and details independently, without carrying over run history", async () => {
  const source = await store.createListing({ name: "Original home", location: "Issaquah", description: "Oak and plaster" });
  await writeFile(path.join(source.dir, "room.jpg"), "original photo");
  await store.saveSelection(source.dir, [{ file: "room.jpg", room: "kitchen", selected: false }]);
  const metaPath = path.join(source.dir, "listing.json");
  const metadata = JSON.parse(await readFile(metaPath, "utf8"));
  await writeFile(metaPath, JSON.stringify({ ...metadata, source: "MLS" }));
  const runDir = path.join(root, ".runs", source.id, "past-run");
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "report.html"), "original report");

  const copy = await store.duplicateListing(source.id);
  expect(copy.id).not.toBe(source.id);
  expect(copy).toMatchObject({
    name: "Copy of Original home", location: "Issaquah", description: "Oak and plaster", source: "MLS",
    deletedAt: null, photos: [{ file: "room.jpg", room: "kitchen", selected: false }],
  });
  expect(await readFile(path.join(copy.dir, "room.jpg"), "utf8")).toBe("original photo");
  await expect(readFile(path.join(root, ".runs", copy.id, "past-run", "report.html"))).rejects.toMatchObject({ code: "ENOENT" });
  await writeFile(path.join(copy.dir, "room.jpg"), "copy changed");
  await store.saveSelection(copy.dir, [{ file: "room.jpg", room: "office", selected: true }]);
  expect(await readFile(path.join(source.dir, "room.jpg"), "utf8")).toBe("original photo");
  expect((await store.readListing(source.dir)).photos).toEqual([{ file: "room.jpg", room: "kitchen", selected: false }]);
  expect((await store.duplicateListing(source.id)).id).not.toBe(copy.id);
});

it("rejects missing or deleted listings without creating a copy", async () => {
  await expect(store.duplicateListing("missing")).rejects.toMatchObject({ status: 404 });
  const source = await store.createListing({ name: "Deleted home" });
  await store.deleteListing(source.id);
  const before = (await store.listListings()).map(l => l.id);
  await expect(store.duplicateListing(source.id)).rejects.toMatchObject({ status: 404 });
  expect((await store.listListings()).map(l => l.id)).toEqual(before);
});
