import { afterAll, expect, it, vi } from "vitest";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";

const { root } = await vi.hoisted(async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  return { root: await mkdtemp(join(tmpdir(), "listing-delete-")) };
});
vi.mock("../src/config.js", async (original) => ({ ...(await original<object>()), ROOT: root }));
const store = await import("../src/listing/listing.js");
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

it("hides deleted listings and restores their photos, metadata, and sidebar position", async () => {
  const first = await store.createListing({ name: "First home" });
  const listing = await store.createListing({ name: "Temporary home", location: "Issaquah", description: "Original description" });
  await writeFile(path.join(listing.dir, "room.jpg"), "original photo");
  await store.saveSelection(listing.dir, [{ file: "room.jpg", room: "kitchen", selected: false }]);
  await store.saveListingOrder([listing.id, first.id]);
  const runDir = path.join(root, ".runs", listing.id, "past-run");
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "report.html"), "past report");

  await store.deleteListing(listing.id);
  expect((await store.listListings()).map(l => l.id)).toEqual([first.id]);
  expect((await store.readListing(listing.dir)).deletedAt).toBeTruthy();
  expect(await readFile(path.join(listing.dir, "room.jpg"), "utf8")).toBe("original photo");
  expect(await readFile(path.join(runDir, "report.html"), "utf8")).toBe("past report");

  await store.restoreListing(listing.id);
  expect(await store.readListing(listing.dir)).toMatchObject({
    id: listing.id, name: "Temporary home", location: "Issaquah", description: "Original description",
    deletedAt: null, photos: [{ file: "room.jpg", room: "kitchen", selected: false }],
  });
  expect((await store.listListings()).map(l => l.id)).toEqual([listing.id, first.id]);
});

it("does not create metadata when deleting or restoring a missing listing", async () => {
  await expect(store.deleteListing("missing")).rejects.toMatchObject({ status: 404 });
  await expect(store.restoreListing("missing")).rejects.toMatchObject({ status: 404 });
});
