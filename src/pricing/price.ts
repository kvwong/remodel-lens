import { costAssumptions, type CostAssumptions } from "./assumptions.js";
import { COST_ITEMS, REGIONS, regionKeyFor, type CostItemKey, type Grade, type Region } from "./catalog.js";

export type UnitPrice = { low: number; high: number; unit: string };

/** Installed cost per unit for one item in one region: national baseline, local labor, grade, and overhead. */
export function unitPrice(key: CostItemKey, grade: Grade, region: Region, assumptions: CostAssumptions = costAssumptions()): UnitPrice {
  const item = COST_ITEMS[key];
  const base = assumptions.items[key] ?? item;
  const local = item.laborShare * region.laborFactor + (1 - item.laborShare);
  const factor = local * assumptions.grades[grade] * (1 + assumptions.overhead);
  return { low: base.low * factor, high: base.high * factor, unit: item.unit };
}

/** The listing's region with its labor factor as currently configured. */
export function pricingRegion(location: string | null | undefined, assumptions: CostAssumptions = costAssumptions()): Region {
  const key = regionKeyFor(location);
  return { ...REGIONS[key], laborFactor: assumptions.laborFactor[key] };
}

const round = (n: number) => (n < 1000 ? Math.round(n / 10) * 10 : Math.round(n / 50) * 50);
const perUnit = (n: number) => (n < 10 ? n.toFixed(2) : String(Math.round(n)));

type Priceable = {
  costItem: CostItemKey | "other";
  quantity: number;
  grade: Grade;
  costLow: number;
  costHigh: number;
  costBasis: string;
};

/**
 * Replace the model's own estimate with table pricing wherever the change maps to a table item and has a
 * usable quantity. Anything else (furniture, appliances, wall removal) keeps the model's estimate, marked so.
 */
export function priceChanges<P extends { changes: Priceable[] }>(plan: P, location: string | null | undefined, assumptions: CostAssumptions = costAssumptions()): P & { changes: Array<P["changes"][number] & { costSource: "table" | "estimate" }> } {
  const region = pricingRegion(location, assumptions);
  return {
    ...plan,
    changes: plan.changes.map((c) => {
      if (c.costItem === "other" || !(c.costItem in COST_ITEMS) || !Number.isFinite(c.quantity) || c.quantity <= 0) {
        return { ...c, costSource: "estimate" as const };
      }
      const price = unitPrice(c.costItem, c.grade, region, assumptions);
      const basis = `${c.quantity} ${price.unit} × $${perUnit(price.low)}–$${perUnit(price.high)}/${price.unit} (${COST_ITEMS[c.costItem].label.toLowerCase()}, ${c.grade} grade, ${region.name})`;
      return {
        ...c,
        costLow: round(c.quantity * price.low),
        costHigh: round(c.quantity * price.high),
        costBasis: c.costBasis ? `${basis}. ${c.costBasis}` : basis,
        costSource: "table" as const,
      };
    }),
  };
}
