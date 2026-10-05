// Unit costs the planner prices against, so dollar figures come from a table rather than the model's guess.
//
// Baselines are Homewyse's "basic cost to install" national figures (materials + labor + supplies,
// favorable site conditions, no contractor overhead or permits), read 2026-10-05 for the September 2026
// update. https://www.homewyse.com/services/ — one page per item, linked below.
// Edit these numbers freely; the tests only check the arithmetic, not the values.

export const GRADES = ["basic", "mid", "premium"] as const;
export type Grade = (typeof GRADES)[number];

export type CostItem = {
  label: string;
  unit: "sq ft" | "lf" | "each";
  /** National basic-grade installed cost per unit, USD. */
  low: number;
  high: number;
  /** Rough share of the installed cost that is labor (an estimate, not from Homewyse); only labor gets the regional wage adjustment. */
  laborShare: number;
  source: string;
};

const HW = (slug: string) => `https://www.homewyse.com/services/cost_to_${slug}.html`;

export const COST_ITEMS = {
  paint_walls: { label: "Paint walls and ceiling", unit: "sq ft", low: 1.3, high: 2.81, laborShare: 0.8, source: HW("paint_wall") },
  paint_cabinets: { label: "Paint cabinets", unit: "sq ft", low: 5.51, high: 10.98, laborShare: 0.8, source: HW("paint_kitchen_cabinets") },
  refinish_wood_floor: { label: "Refinish wood floor", unit: "sq ft", low: 6.64, high: 8.1, laborShare: 0.75, source: HW("refinish_hardwood_floor") },
  light_fixture: { label: "Light fixture (same location)", unit: "each", low: 405, high: 602, laborShare: 0.4, source: HW("install_lighting_fixture") },
  wall_light: { label: "Wall light / sconce", unit: "each", low: 675, high: 1217, laborShare: 0.5, source: HW("install_wall_lighting") },
  wood_floor: { label: "Wood flooring", unit: "sq ft", low: 13.96, high: 17.72, laborShare: 0.45, source: HW("install_wood_floor") },
  laminate_floor: { label: "Laminate flooring", unit: "sq ft", low: 7.12, high: 12.15, laborShare: 0.45, source: HW("install_laminate_flooring") },
  vinyl_floor: { label: "Vinyl plank or tile flooring", unit: "sq ft", low: 9.68, high: 14.35, laborShare: 0.45, source: HW("install_vinyl_tile_flooring") },
  tile_floor: { label: "Ceramic or porcelain floor tile", unit: "sq ft", low: 16.79, high: 20.73, laborShare: 0.6, source: HW("install_tile_floor") },
  stone_floor: { label: "Stone floor tile", unit: "sq ft", low: 29.31, high: 36.47, laborShare: 0.5, source: HW("install_stone_floor_tile") },
  wall_tile: { label: "Wall or shower tile", unit: "sq ft", low: 11.84, high: 21.89, laborShare: 0.6, source: HW("install_wall_tile") },
  backsplash: { label: "Kitchen backsplash", unit: "sq ft", low: 34.88, high: 59.13, laborShare: 0.6, source: HW("install_kitchen_backsplash") },
  cabinet: { label: "Kitchen cabinet box (each, installed)", unit: "each", low: 511, high: 774, laborShare: 0.35, source: HW("install_kitchen_cabinets") },
  quartz_countertop: { label: "Quartz countertop", unit: "sq ft", low: 130, high: 169, laborShare: 0.3, source: HW("install_quartz_countertop") },
  stone_countertop: { label: "Granite or natural stone countertop", unit: "sq ft", low: 105, high: 152, laborShare: 0.3, source: HW("install_granite_countertops") },
  vanity: { label: "Bathroom vanity", unit: "each", low: 608, high: 918, laborShare: 0.4, source: HW("install_bathroom_vanity") },
  toilet: { label: "Toilet (same location)", unit: "each", low: 654, high: 1189, laborShare: 0.4, source: HW("install_toilet") },
  faucet: { label: "Faucet (same location)", unit: "each", low: 480, high: 797, laborShare: 0.4, source: HW("install_kitchen_faucet") },
  interior_door: { label: "Interior door", unit: "each", low: 440, high: 669, laborShare: 0.5, source: HW("install_interior_door") },
  baseboard: { label: "Baseboard or casing", unit: "lf", low: 9.26, high: 14.17, laborShare: 0.65, source: HW("install_baseboard") },
  crown_molding: { label: "Crown molding", unit: "lf", low: 14.77, high: 22.61, laborShare: 0.65, source: HW("install_crown_molding") },
} as const satisfies Record<string, CostItem>;

export type CostItemKey = keyof typeof COST_ITEMS;
export const COST_ITEM_KEYS = Object.keys(COST_ITEMS) as CostItemKey[];

/**
 * Homewyse "basic" is builder-grade. These are assumptions, not sourced: mid ≈ mid-market custom
 * (what the planner proposes by default), premium ≈ designer-level materials.
 */
export const GRADE_MULTIPLIER: Record<Grade, number> = { basic: 1, mid: 1.4, premium: 2 };

/** General contractor overhead and profit, permits, and cleanup, which Homewyse excludes. An assumption. */
export const OVERHEAD = 0.2;

export type Region = { name: string; laborFactor: number; source: string };

/**
 * Labor factor = metro mean hourly wage for "Construction and extraction" ÷ the national mean.
 * BLS OEWS, May 2025: Seattle-Tacoma-Bellevue $42.11 vs. US $31.42.
 * https://www.bls.gov/regions/west/news-release/occupationalemploymentandwages_seattle.htm
 *
 * Contractors' Eastside guides put Bellevue and Mercer Island well above Seattle, but they attribute the gap
 * to bigger kitchens and higher-end finishes, not unit prices, so it is not a separate multiplier here.
 * Quantities and grade carry it.
 */
export const REGIONS = {
  seattle: { name: "Seattle and the Eastside", laborFactor: 42.11 / 31.42, source: "BLS OEWS May 2025" },
  national: { name: "US national average", laborFactor: 1, source: "Homewyse national baseline" },
} as const satisfies Record<string, Region>;

const SEATTLE_AREA =
  /\b(seattle|bellevue|mercer island|issaquah|kirkland|redmond|sammamish|newcastle|renton|bothell|woodinville|medina|clyde hill|yarrow point|hunts point|eastside|king county)\b|\b98[01]\d\d\b/i;

export function regionFor(location: string | null | undefined): Region {
  return location && SEATTLE_AREA.test(location) ? REGIONS.seattle : REGIONS.national;
}
