import { afterEach, expect, it, vi } from "vitest";
import sharp from "sharp";

import { judge, verdict, type JudgeResult } from "../src/redesign/verify.js";

const png = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: "#ccc" } }).png().toBuffer();
const inventory = { fixed: [{ kind: "window", description: "two-sash window on the left wall", box: [100, 100, 300, 400] }, { kind: "fireplace", description: "brick fireplace", box: [500, 400, 700, 800] }] } as never;
const plan = { tier: "moderate", changes: [{ element: "floor", proposed: "white oak" }], removedWalls: [] } as never;
const input = { model: "openai/test", original: png, redesign: png, inventory, plan };
const fullResult: JudgeResult = { fixedChecks: [{ element: "window", preserved: false, note: "window moved right" }], openingsChanged: true, cameraChanged: false, roomSizeChanged: false, planAdherence: 7, scopeExceeded: false, unplannedChanges: [], issues: ["window moved"] };

const answers = (preserved: number[], changed = 0.02, score = 3) => [
  ...preserved.map((p, i) => ({ type: "predicate", name: `preserved_${i}`, probability: p })),
  ...["openings_changed", "camera_changed", "room_size_changed"].map((name) => ({ type: "predicate", name, probability: changed })),
  { type: "predicate", name: "scope_compliant", probability: 0.98 },
  { type: "score", name: "plan_adherence", score, confidence: 0.8 },
];

function fakeFetch(body: unknown, status = 200) {
  const requests: Array<{ model: string; questions: Array<{ name: string; type: string }>; input: Array<{ content: Array<{ type: string; image_url?: string }> }> }> = [];
  const fn = (async (_url: string, init: { body: string }) => {
    requests.push(JSON.parse(init.body));
    return new Response(JSON.stringify(body), { status });
  }) as never;
  return { fn, requests };
}

afterEach(() => { delete process.env.QUICK_JUDGE; });
process.env.OPENAI_API_KEY = "test";

it("takes a clear pass from the Decisions API without calling the full judge", async () => {
  const { fn, requests } = fakeFetch({ answers: answers([0.97, 0.95]) });
  const full = vi.fn(async () => fullResult);
  const result = await judge(input, { fetch: fn, full });
  expect(full).not.toHaveBeenCalled();
  expect(requests[0]).toMatchObject({ model: "gpt-6-luna" });
  expect(requests[0]!.questions.map((q) => q.name)).toEqual(["preserved_0", "preserved_1", "openings_changed", "camera_changed", "room_size_changed", "scope_compliant", "plan_adherence"]);
  expect(requests[0]!.input[0]!.content.filter((c) => c.type === "input_image").map((c) => c.image_url!.slice(0, 23))).toEqual(["data:image/jpeg;base64,", "data:image/jpeg;base64,"]);
  expect(result).toMatchObject({ openingsChanged: false, cameraChanged: false, roomSizeChanged: false, planAdherence: 8, issues: [] });
  expect(result.fixedChecks.every((c) => c.preserved)).toBe(true);
});

it("sends doubtful or failing images to the full judge, so its notes still feed the retry", async () => {
  for (const body of [{ answers: answers([0.97, 0.6]) }, { answers: answers([0.97, 0.97], 0.4) }, { answers: answers([0.97]) }]) {
    const full = vi.fn(async () => fullResult);
    expect(await judge(input, { fetch: fakeFetch(body).fn, full })).toBe(fullResult);
    expect(full).toHaveBeenCalledOnce();
  }
});

it("falls back to the full judge when the Decisions API fails or is turned off", async () => {
  const full = vi.fn(async () => fullResult);
  expect(await judge(input, { fetch: fakeFetch({ error: "nope" }, 404).fn, full })).toBe(fullResult);
  process.env.QUICK_JUDGE = "off";
  const off = fakeFetch({ answers: answers([0.99, 0.99]) });
  expect(await judge(input, { fetch: off.fn, full })).toBe(fullResult);
  expect(off.requests).toHaveLength(0);
});

 it("requires scope compliance for a fast pass", async () => {
  for (const probability of [0.2, 0.7]) {
    const body = answers([0.98, 0.98]).map(a => a.name === "scope_compliant" ? { ...a, probability } : a);
    const full = vi.fn(async () => fullResult);
    expect(await judge(input, { fetch: fakeFetch({ answers: body }).fn, full })).toBe(fullResult);
    expect(full).toHaveBeenCalledOnce();
  }
});

it("rejects a full judge finding that the redesign exceeded its scope", () => {
  expect(verdict([], { ...fullResult, fixedChecks: [], openingsChanged: false, scopeExceeded: true, unplannedChanges: ["Kitchen island moved in Cosmetic scope"] }))
    .toMatchObject({ verdict: "failed", reasons: expect.arrayContaining(["Changes exceed the selected remodel scope.", "Kitchen island moved in Cosmetic scope"]) });
});
