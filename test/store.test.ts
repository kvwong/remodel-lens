import { rm } from "node:fs/promises";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";

import { progressAdd, progressContext, progressDone, type Progress } from "../src/files.js";
import {
  addReference,
  createTasteProfile,
  profileDir,
  readTasteProfile,
  removeReference,
  restorePreviousProfile,
  restoreReference,
  saveBrief,
  saveProfileJson,
} from "../src/taste/store.js";

const created: string[] = [];
afterAll(async () => {
  for (const id of created) await rm(profileDir(id), { recursive: true, force: true });
});

const swatch = (hue: number) =>
  sharp({ create: { width: 320, height: 240, channels: 3, background: { r: hue, g: 120, b: 255 - hue } } })
    .composite([{ input: Buffer.from(`<svg width="320" height="240"><rect x="${hue % 200}" y="40" width="90" height="120" fill="#222"/></svg>`), left: 0, top: 0 }])
    .png()
    .toBuffer();

const profile = (rule: string) => ({
  summary: "s", era: "e",
  palette: { walls: [], woodTones: [], metals: [], accents: [], contrast: "low" as const, saturation: "muted" as const },
  categories: [{ category: "flooring" as const, rules: [{ rule, support: 1, fromBrief: false }], avoid: [] }],
  expressions: [], globalAvoid: [], roomNotes: [], imagePromptSummary: "x", imageCount: 3,
});

describe("taste profile store", () => {
  it("creates, adds references, refuses duplicates, and soft-deletes with undo", async () => {
    const id = await createTasteProfile(`Test ${Date.now()}`);
    created.push(id);
    expect(await addReference(id, await swatch(10))).toBe("ref-01.jpg");
    expect(await addReference(id, await swatch(200))).toBe("ref-02.jpg");
    await expect(addReference(id, await swatch(10))).rejects.toThrow(/Already in this profile as ref-01/);
    await expect(addReference(id, Buffer.from("not an image"))).rejects.toThrow(/isn't an image/);
    // Same picture re-encoded with an alpha channel (e.g. a WebP or PNG export) is still a duplicate.
    const withAlpha = await sharp(await swatch(200)).ensureAlpha().webp().toBuffer();
    await expect(addReference(id, withAlpha)).rejects.toThrow(/Already in this profile as ref-02/);

    await removeReference(id, "ref-01.jpg");
    expect((await readTasteProfile(id))!.references).toEqual(["ref-02.jpg"]);
    await restoreReference(id, "ref-01.jpg");
    expect((await readTasteProfile(id))!.references).toEqual(["ref-01.jpg", "ref-02.jpg"]);
  });

  it("flags rules as out of date when references or brief change after a build, and restores the previous version", async () => {
    const id = await createTasteProfile(`Stale ${Date.now()}`);
    created.push(id);
    await addReference(id, await swatch(40));
    await saveProfileJson(id, profile("first"), "pipeline");
    expect((await readTasteProfile(id))!.stale).toBe(false);

    await saveBrief(id, "Warm oak.");
    expect((await readTasteProfile(id))!.stale).toBe(true);

    await saveProfileJson(id, profile("second"), "manual"); // manual edits don't claim to be in sync
    expect((await readTasteProfile(id))!.stale).toBe(true);
    expect(await restorePreviousProfile(id)).toBe(true);
    expect((await readTasteProfile(id))!.profile!.categories[0]!.rules[0]!.rule).toBe("first");
  });

  it("duplicates a profile with its references and brief, in sync with the source", async () => {
    const src = await createTasteProfile(`Source ${Date.now()}`);
    created.push(src);
    await addReference(src, await swatch(90));
    await saveBrief(src, "Plaster and timber.");
    await saveProfileJson(src, profile("rule"), "pipeline");
    const copy = await createTasteProfile("Copy", src);
    created.push(copy);
    const c = (await readTasteProfile(copy))!;
    expect(c.references).toEqual(["ref-01.jpg"]);
    expect(c.brief).toBe("Plaster and timber.");
    expect(c.stale).toBe(false);
  });
});

describe("progress", () => {
  it("accumulates units inside a run context and clamps at the total", async () => {
    const p: Progress = { total: 0, done: 0, label: "" };
    await progressContext.run(p, async () => {
      progressAdd(10);
      progressDone(4, "half");
      progressAdd(3); // a retry extends the total instead of rewinding
      progressDone(20, "done");
    });
    expect(p).toEqual({ total: 13, done: 13, label: "done" });
  });
});

describe("listing photos", () => {
  it("refuses a re-encoded duplicate but accepts a different image", async () => {
    const { addListingPhoto, createListing } = await import("../src/listing/listing.js");
    const listing = await createListing({ name: `zz test ${Date.now()}` });
    try {
      const photo = await swatch(10);
      expect(await addListingPhoto(listing.dir, photo)).toMatch(/-01\.jpg$/);
      const reencoded = await sharp(photo).webp({ quality: 70 }).toBuffer();
      await expect(addListingPhoto(listing.dir, reencoded)).rejects.toThrow(/Already in this listing/);
      const otherImage = await swatch(200);
      expect(await addListingPhoto(listing.dir, otherImage)).toMatch(/-02\.jpg$/);
    } finally {
      await rm(listing.dir, { recursive: true, force: true });
    }
  });
});
