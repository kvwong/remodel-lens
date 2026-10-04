import { afterAll, expect, it, vi } from "vitest";
import { readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";

const { root } = await vi.hoisted(async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  return { root: await mkdtemp(join(tmpdir(), "taste-delete-")) };
});
vi.mock("../src/config.js", async (original) => ({ ...(await original<object>()), ROOT: root }));
const store = await import("../src/taste/store.js");
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

it("hides deleted profiles, preserves their source files, and restores the same profile", async () => {
  const id = await store.createTasteProfile("Temporary taste", null, "Test direction");
  const dir = store.profileDir(id);
  await writeFile(path.join(dir, "brief.md"), "Keep authentic wood");
  await writeFile(path.join(dir, "references", "room.jpg"), "reference bytes");
  expect((await store.listTasteProfiles()).map(p => p.id)).toContain(id);
  await store.deleteTasteProfile(id);
  expect(await store.readTasteProfile(id)).toBeNull();
  expect((await store.listTasteProfiles()).map(p => p.id)).not.toContain(id);
  expect(await readFile(path.join(dir, "brief.md"), "utf8")).toBe("Keep authentic wood");
  expect(await readFile(path.join(dir, "references", "room.jpg"), "utf8")).toBe("reference bytes");
  await store.restoreTasteProfile(id);
  const restored = await store.readTasteProfile(id);
  expect(restored?.meta.name).toBe("Temporary taste");
  expect(restored?.meta.description).toBe("Test direction");
  expect(restored?.references).toEqual(["room.jpg"]);
  expect((await store.listTasteProfiles()).map(p => p.id)).toContain(id);
});
