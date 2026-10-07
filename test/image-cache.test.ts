import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { expect, it, vi } from "vitest";
import { cachedImage, imagePreview } from "../src/image-cache.js";
import { previewAttributes } from "../src/report.js";

it("coalesces concurrent conversions and retries a failed conversion", async () => {
  let calls = 0;
  const key = randomUUID();
  const build = async () => { calls++; await new Promise(r => setTimeout(r, 10)); return Buffer.from("preview"); };
  const results = await Promise.all([cachedImage(key, build), cachedImage(key, build)]);
  expect(calls).toBe(1);
  vi.resetModules();
  const fresh = await import("../src/image-cache.js");
  expect(await fresh.cachedImage(key, async () => { throw new Error("must use disk cache"); })).toEqual(Buffer.from("preview"));
  expect(results[0]).toEqual(results[1]);
  const failed = randomUUID();
  await expect(cachedImage(failed, async () => { throw new Error("failed"); })).rejects.toThrow("failed");
  expect(await cachedImage(failed, build)).toEqual(Buffer.from("preview"));
});

it("invalidates previews when a source changes and preserves aspect ratio", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "whim-preview-"));
  const file = path.join(dir, "source.png");
  try {
    await sharp({ create: { width: 1200, height: 800, channels: 3, background: "red" } }).png().toFile(file);
    const first = await imagePreview(file, 960);
    const meta = await sharp(first.bytes).metadata();
    expect([meta.width, meta.height, meta.format]).toEqual([960, 640, "webp"]);
    await writeFile(file, await sharp({ create: { width: 1200, height: 800, channels: 3, background: "blue" } }).png().toBuffer());
    const second = await imagePreview(file, 960);
    expect(second.version).not.toBe(first.version);
    expect(second.bytes).not.toEqual(first.bytes);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("uses app preview routes while retaining standalone report compatibility", () => {
  expect(previewAttributes("room/original.png", "/thumb/runs/listing/run")).toContain("/thumb/runs/listing/run/room/original.png?w=960");
  expect(previewAttributes("room/original.png")).toBe('src="room/original.png"');
});
