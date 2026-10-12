import { afterAll, expect, it, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const { root } = await vi.hoisted(async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  return { root: await mkdtemp(join(tmpdir(), "home-")) };
});
vi.mock("../src/config.js", async (original) => ({ ...(await original<object>()), ROOT: root }));
const { homeView } = await import("../src/app/home-api.js");
const store = await import("../src/listing/listing.js");
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

const tier = (name: string, status: string, image: string | null) => ({ tier: name, status, image, plan: {}, reasons: [], warnings: [], attempts: 1, editableShare: null, edges: [], judgement: null });

async function addRun(listing: string, id: string, startedAt: string, photos: unknown[] | null, report: string | null = "report.html") {
  const dir = path.join(root, ".runs", "redesign", listing, id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "run.json"), JSON.stringify({ id, listing, profile: "profiles/x/profile.json", tiers: ["cosmetic"], photos: [], startedAt, finishedAt: startedAt, counts: {}, report, error: null }));
  if (photos) await writeFile(path.join(dir, "results.json"), JSON.stringify(photos));
}

it("lists the seven newest reports across listings and reels their passing redesigns", async () => {
  const a = await store.createListing({ name: "Maple St" });
  const b = await store.createListing({ name: "Lakeview" });
  for (let i = 1; i <= 7; i++) await addRun(a.id, `a${i}`, `2026-10-0${i}T10:00:00.000Z`, null);
  await addRun(b.id, "b-new", "2026-10-09T10:00:00.000Z", [
    { id: "p0", basename: "k.jpg", room: "kitchen", original: "k.jpg", inventory: { roomType: "kitchen" }, tiers: [tier("cosmetic", "verified", "images/k-c.png"), tier("moderate", "failed", "images/k-m.png")] },
    { id: "p1", basename: "b.jpg", room: "", original: "b.jpg", inventory: { roomType: "bathroom" }, tiers: [tier("cosmetic", "review", "images/b c.png"), tier("moderate", "error", null)] },
  ]);
  await addRun(b.id, "b-running", "2026-10-10T10:00:00.000Z", null, null);

  const home = await homeView();
  expect(home.totalReports).toBe(8);
  expect(home.reports.map((r) => r.id)).toEqual(["b-new", "a7", "a6", "a5", "a4", "a3", "a2"]);
  expect(home.reports[0]).toMatchObject({ listingName: "Lakeview", reportUrl: `/files/runs/${b.id}/b-new/report.html` });
  expect(home.reports[0]!.images.map((i) => i.src)).toEqual([`/thumb/runs/${b.id}/b-new/images/k-c.png?w=240`, `/thumb/runs/${b.id}/b-new/images/b%20c.png?w=240`]);
  expect(home.reports[1]!.images).toEqual([]);
  expect(home.slides).toEqual([
    { src: `/thumb/runs/${b.id}/b-new/images/k-c.png?w=720`, alt: "Cosmetic redesign of the kitchen at Lakeview", caption: "Lakeview · Kitchen · Cosmetic", reportUrl: `/files/runs/${b.id}/b-new/report.html?scope=cosmetic` },
  ]);
});

it("orders scope representatives newest first and prefers passing main-room photos", async () => {
  const listing = await store.createListing({ name: "Scope reel" });
  const photo = (room: string, tiers: unknown[]) => ({ id: room, room, inventory: { roomType: room }, tiers });
  await addRun(listing.id, "older", "2026-11-01T10:00:00.000Z", [photo("kitchen", [tier("cosmetic", "verified", "old.png")])]);
  await addRun(listing.id, "newer", "2026-11-02T10:00:00.000Z", [
    photo("bathroom", [tier("cosmetic", "verified", "bath.png"), tier("moderate", "review", "bath-m.png")]),
    photo("kitchen", [tier("cosmetic", "verified", "kitchen.png"), tier("moderate", "verified", "kitchen-m.png"), tier("major", "failed", "failed.png")]),
  ]);
  const slides = (await homeView()).slides.filter((s) => s.caption.startsWith("Scope reel"));
  expect(slides.map((s) => s.src)).toEqual([
    `/thumb/runs/${listing.id}/newer/kitchen.png?w=720`,
    `/thumb/runs/${listing.id}/newer/kitchen-m.png?w=720`,
    `/thumb/runs/${listing.id}/older/old.png?w=720`,
  ]);
  expect((await homeView()).slides.filter((s) => s.caption.startsWith("Scope reel"))).toEqual(slides);
});
