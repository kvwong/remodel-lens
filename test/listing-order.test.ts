import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listListings, saveListingOrder } from "../src/listing/listing.js";

let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

async function add(id: string, name: string) {
  await mkdir(path.join(dir, id));
  await writeFile(path.join(dir, id, "listing.json"), JSON.stringify({ name, photos: {} }));
}

describe("listing order", () => {
  it("persists custom order, keeps renamed listings in place, and appends new listings", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "listing-order-"));
    await add("alpha", "Alpha");
    await add("beta", "Beta");
    expect((await listListings(dir)).map((listing) => listing.id)).toEqual(["alpha", "beta"]);
    await saveListingOrder(["beta", "alpha"], dir);
    await writeFile(path.join(dir, "beta", "listing.json"), JSON.stringify({ name: "Zulu", photos: {} }));
    await add("aardvark", "Aardvark");
    expect((await listListings(dir)).map((listing) => listing.id)).toEqual(["beta", "alpha", "aardvark"]);
    await rm(path.join(dir, "beta"), { recursive: true });
    expect((await listListings(dir)).map((listing) => listing.id)).toEqual(["alpha", "aardvark"]);
  });

  it("rejects duplicate, missing, or unknown listings without replacing the saved order", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "listing-order-"));
    await add("alpha", "Alpha");
    await add("beta", "Beta");
    await saveListingOrder(["beta", "alpha"], dir);
    for (const ids of [["alpha", "alpha"], ["alpha"], ["alpha", "unknown"]]) {
      await expect(saveListingOrder(ids, dir)).rejects.toMatchObject({ status: 409 });
    }
    expect((await listListings(dir)).map((listing) => listing.id)).toEqual(["beta", "alpha"]);
  });
});
