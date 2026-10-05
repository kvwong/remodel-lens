import { describe, expect, it } from "vitest";

import { COST_ITEMS, GRADE_MULTIPLIER, OVERHEAD, REGIONS, regionFor } from "../src/pricing/catalog.js";
import { priceChanges, unitPrice } from "../src/pricing/price.js";

const change = (c: Partial<Parameters<typeof priceChanges>[0]["changes"][number]>) => ({
  costItem: "other" as const, quantity: 0, grade: "mid" as const, costLow: 1000, costHigh: 2000, costBasis: "", ...c,
});

describe("regional pricing", () => {
  it("recognizes Eastside cities and Seattle ZIP codes", () => {
    for (const loc of ["Bellevue, WA", "Mercer Island", "Issaquah WA 98027", "98004", "Kirkland, Washington"]) {
      expect(regionFor(loc)).toBe(REGIONS.seattle);
    }
    expect(regionFor("Portland, OR")).toBe(REGIONS.national);
    expect(regionFor(null)).toBe(REGIONS.national);
  });

  it("adjusts only the labor share for local wages", () => {
    const item = COST_ITEMS.paint_walls;
    const p = unitPrice("paint_walls", "basic", REGIONS.seattle);
    const factor = (item.laborShare * REGIONS.seattle.laborFactor + 1 - item.laborShare) * (1 + OVERHEAD);
    expect(p.low).toBeCloseTo(item.low * factor);
    expect(unitPrice("paint_walls", "premium", REGIONS.national).high).toBeCloseTo(item.high * GRADE_MULTIPLIER.premium * (1 + OVERHEAD));
  });

  it("prices table items from quantity and keeps the model's figure otherwise", () => {
    const { changes } = priceChanges(
      { changes: [change({ costItem: "quartz_countertop", quantity: 40, costBasis: "L-shaped run" }), change({}), change({ costItem: "wood_floor", quantity: 0 })] },
      "Bellevue, WA",
    );
    const p = unitPrice("quartz_countertop", "mid", REGIONS.seattle);
    expect(changes[0]).toMatchObject({ costSource: "table", costLow: Math.round((40 * p.low) / 50) * 50, costHigh: Math.round((40 * p.high) / 50) * 50 });
    expect(changes[0]!.costBasis).toMatch(/^40 sq ft × \$\d+–\$\d+\/sq ft .*Seattle and the Eastside\)\. L-shaped run$/);
    expect(changes[1]).toMatchObject({ costSource: "estimate", costLow: 1000, costHigh: 2000 });
    expect(changes[2]).toMatchObject({ costSource: "estimate" });
  });
});
