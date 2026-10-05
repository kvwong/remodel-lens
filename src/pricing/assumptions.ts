// The editable side of the cost model: labor factors, grade multipliers, overhead, and unit-cost overrides.
// Defaults come from catalog.ts; the settings page can replace any of them for new redesigns.
import { COST_ITEMS, GRADE_MULTIPLIER, OVERHEAD, REGIONS, type CostItemKey, type Grade } from "./catalog.js";

export type RegionKey = keyof typeof REGIONS;

export type CostAssumptions = {
  laborFactor: Record<RegionKey, number>;
  grades: Record<Grade, number>;
  overhead: number;
  /** National basic-grade installed cost per unit, replacing the catalog's figures. */
  items: Partial<Record<CostItemKey, { low: number; high: number }>>;
};

export type CostOverrides = {
  laborFactor?: Partial<Record<RegionKey, number>> | undefined;
  grades?: Partial<Record<Grade, number>> | undefined;
  overhead?: number | undefined;
  items?: Partial<Record<CostItemKey, { low: number; high: number }>> | undefined;
};

export const DEFAULT_COST_ASSUMPTIONS: CostAssumptions = {
  laborFactor: { seattle: REGIONS.seattle.laborFactor, national: REGIONS.national.laborFactor },
  grades: { ...GRADE_MULTIPLIER },
  overhead: OVERHEAD,
  items: {},
};

let current: CostAssumptions = DEFAULT_COST_ASSUMPTIONS;

export function resolveCostAssumptions(overrides: CostOverrides = {}): CostAssumptions {
  const items: CostAssumptions["items"] = {};
  for (const [key, value] of Object.entries(overrides.items ?? {})) {
    if (key in COST_ITEMS && value) items[key as CostItemKey] = value;
  }
  return {
    laborFactor: { ...DEFAULT_COST_ASSUMPTIONS.laborFactor, ...overrides.laborFactor },
    grades: { ...DEFAULT_COST_ASSUMPTIONS.grades, ...overrides.grades },
    overhead: overrides.overhead ?? DEFAULT_COST_ASSUMPTIONS.overhead,
    items,
  };
}

/** Set by the settings store at startup and on every save. */
export function setCostOverrides(overrides: CostOverrides): void {
  current = resolveCostAssumptions(overrides);
}

export function costAssumptions(): CostAssumptions {
  return current;
}
