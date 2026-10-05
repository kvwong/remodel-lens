import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { costAssumptions, resolveCostAssumptions, setCostOverrides } from "../src/pricing/assumptions.js";
import { COST_ITEMS, REGIONS } from "../src/pricing/catalog.js";
import { priceChanges, unitPrice } from "../src/pricing/price.js";
import { applySettings, environmentValue, maskKey, readSettings, saveSettings, Settings } from "../src/settings.js";
import { setLabel } from "../src/tune/collect.js";
import type { AttemptRecord } from "../src/tune/analyze.js";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "settings-"));
  process.env.OPENAI_API_KEY = "sk-from-env-file-0000";
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.REASONING_MODEL;
  delete process.env.EDGE_THRESHOLD;
  return () => rm(dir, { recursive: true, force: true });
});
afterEach(() => {
  applySettings(Settings.parse({}));
});

describe("settings store", () => {
  it("overrides the environment and falls back to it when cleared", async () => {
    const file = path.join(dir, "settings.json");
    await saveSettings(Settings.parse({ keys: { openai: "sk-saved-on-page-1234" }, models: { reasoning: "anthropic/claude-sonnet-5-5" }, tuning: { edgeThreshold: 0.4 } }), file);
    expect(process.env.OPENAI_API_KEY).toBe("sk-saved-on-page-1234");
    expect(process.env.REASONING_MODEL).toBe("anthropic/claude-sonnet-5-5");
    expect(process.env.EDGE_THRESHOLD).toBe("0.4");
    expect(environmentValue("OPENAI_API_KEY")).toBe("sk-from-env-file-0000");
    expect(readSettings(file).keys.openai).toBe("sk-saved-on-page-1234");
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    await saveSettings(Settings.parse({}), file);
    expect(process.env.OPENAI_API_KEY).toBe("sk-from-env-file-0000");
    expect(process.env.REASONING_MODEL).toBeUndefined();
    expect(process.env.EDGE_THRESHOLD).toBeUndefined();
  });

  it("rejects model ids the providers can't route and thresholds outside 0–1", () => {
    expect(() => Settings.parse({ models: { reasoning: "gpt-6.1-sol" } })).toThrow();
    expect(() => Settings.parse({ tuning: { edgeThreshold: 1.2 } })).toThrow();
    expect(() => Settings.parse({ costs: { items: { paint_walls: { low: 5, high: 2 } } } })).toThrow();
    expect(() => Settings.parse({ costs: { items: { not_an_item: { low: 1, high: 2 } } } })).toThrow();
  });

  it("never shows more than the last four characters of a key", () => {
    expect(maskKey("sk-proj-abcdefghijklmnop1234")).toBe("…1234");
    expect(maskKey("short")).toBe("…");
    expect(maskKey(undefined)).toBeNull();
  });
});

describe("cost assumptions", () => {
  afterEach(() => setCostOverrides({}));

  it("defaults to the catalog", () => {
    expect(costAssumptions().overhead).toBeCloseTo(0.2);
    expect(costAssumptions().laborFactor.seattle).toBeCloseTo(REGIONS.seattle.laborFactor);
  });

  it("prices new plans with saved overrides", () => {
    const item = COST_ITEMS.paint_walls;
    applySettings(Settings.parse({ costs: { laborFactor: { national: 1.5 }, grades: { mid: 1.6 }, overhead: 0.1, items: { paint_walls: { low: 2, high: 4 } } } }));
    const p = unitPrice("paint_walls", "mid", { ...REGIONS.national, laborFactor: 1.5 });
    const factor = (item.laborShare * 1.5 + 1 - item.laborShare) * 1.6 * 1.1;
    expect(p.low).toBeCloseTo(2 * factor);
    expect(p.high).toBeCloseTo(4 * factor);

    const plan = { changes: [{ costItem: "paint_walls" as const, quantity: 100, grade: "mid" as const, costLow: 0, costHigh: 0, costBasis: "" }] };
    const priced = priceChanges(plan, "Portland, OR").changes[0]!;
    expect(priced.costLow).toBe(Math.round((100 * 2 * factor) / 10) * 10);
  });

  it("ignores unknown items", () => {
    expect(resolveCostAssumptions({ items: { nope: { low: 1, high: 2 } } as never }).items).toEqual({});
  });
});

describe("labels from the settings page", () => {
  it("writes the same labels.json the CLI reads", async () => {
    const file = path.join(dir, "tuning", "labels.json");
    const record = { key: "l/r/p/cosmetic/1", judgeBroken: true, edges: [{ kind: "window", correlation: 0.3 }], original: "/o.png", redesign: "/r.png" } as AttemptRecord;
    await setLabel(file, record, "ok");
    expect(JSON.parse(await readFile(file, "utf8"))[record.key]).toMatchObject({ label: "ok", judge: "broken", minCorrelation: 0.3 });
    await setLabel(file, record, null);
    expect(JSON.parse(await readFile(file, "utf8"))[record.key].label).toBeNull();
  });
});
