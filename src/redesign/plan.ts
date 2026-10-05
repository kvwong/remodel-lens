import { z } from "zod";

import type { RoomInventory } from "../listing/inventory.js";
import { COST_ITEM_KEYS, COST_ITEMS, GRADES } from "../pricing/catalog.js";
import { priceChanges } from "../pricing/price.js";
import { generateStructured } from "../providers.js";
import { isStrongRule } from "../taste/pipeline.js";
import type { TasteProfile } from "../taste/schema.js";
import { allowedAt, TIER_DEFINITIONS, TIERS, type Tier } from "./tiers.js";

/** Universal realism constraints; these apply regardless of taste. Material and style preferences belong in the taste profile. */
export const PRACTICAL_CONSTRAINTS = [
  "Show every material as what it is: a painted, laminate, or veneer finish must not be rendered as solid wood or stone.",
  "Never invent vaulted ceilings, double-height space, larger windows, or floor area.",
  "Keep furniture and cabinetry realistically scaled to the room; nothing oversized.",
  "Maintain usable circulation, door swings, appliance access, and chair clearance.",
  "Keep the relationship to adjacent spaces (what is visible through openings) unchanged.",
  "Use one coherent architectural language for the room, matched to the existing house.",
];

const ROOM_ALIASES: Record<string, string[]> = {
  kitchen: ["kitchen", "kitchenette", "pantry"],
  "living room": ["living", "family", "great room", "media", "lounge", "den", "sitting room"],
  "home office": ["office", "study", "library", "workspace"],
  "dining room": ["dining", "breakfast nook"],
  bathroom: ["bath", "powder", "ensuite", "en suite"],
  bedroom: ["bedroom", "primary suite", "nursery"],
  gym: ["gym", "exercise", "workout", "fitness"],
};

/** Room notes whose room name matches the inventory's free-text room type (e.g. "open kitchen and family room"). */
export function roomNotesFor(profile: TasteProfile, roomType: string): TasteProfile["roomNotes"] {
  const type = roomType.toLowerCase();
  return profile.roomNotes.filter((note) => {
    const room = note.room.toLowerCase();
    const aliases = ROOM_ALIASES[room] ?? [room];
    return type.includes(room) || aliases.some((alias) => type.includes(alias));
  });
}

export const ChangePlan = z.object({
  tier: z.enum(TIERS),
  expression: z
    .string()
    .describe("The one taste expression this room uses, by name from the profile's expressions, chosen to suit the existing room. Empty string if the profile has none."),
  architecturalLanguage: z
    .string()
    .describe("The single design language for this room given the existing house, e.g. 'traditional: painted shaker cabinets, cased openings' or 'modern: flat-slab cabinetry, minimal trim'."),
  changes: z.array(
    z.object({
      element: z.string().describe("Must match a changeable element (or wall, for major) from the inventory."),
      current: z.string(),
      proposed: z.string().describe("Specific material, finish, color, silhouette."),
      minTier: z.enum(TIERS),
      costItem: z
        .enum([...COST_ITEM_KEYS, "other"])
        .describe("The cost table item this change is priced as, or 'other' if none fits (furniture, decor, appliances, wall removal, built-ins)."),
      quantity: z.number().describe("Quantity in the cost item's unit, measured from the photo. 0 for 'other'."),
      grade: z.enum(GRADES).describe("Material grade of what is proposed: basic (builder-grade), mid (mid-market custom), premium (designer-level, natural stone, solid hardwood)."),
      costLow: z.number().int().describe("Low end of installed cost in USD (materials + labor) for this change in this room."),
      costHigh: z.number().int().describe("High end of installed cost in USD."),
      costBasis: z.string().describe("Quantity and assumption behind the range, e.g. '≈18 lf base + 12 lf upper cabinets, solid oak slab, plywood boxes'."),
      tasteRules: z.array(z.string()).describe("The taste rules this change applies."),
      note: z.string().nullable(),
    }),
  ),
  removedWalls: z.array(z.string()).describe("Major tier only: wall descriptions from the inventory being removed. Empty otherwise."),
  preserve: z.array(z.string()).describe("Everything that must look identical: openings, ceiling, camera, plus unchanged items."),
  feasibilityFlags: z.array(z.string()).describe("Risks a buyer should check: load-bearing, plumbing moves, permits, condition."),
  beyondScope: z
    .array(z.string())
    .describe("Work beyond this tier that the full taste would need, stated as real construction (e.g. 'replace cabinet boxes and doors in the same layout — moderate tier'). Empty if this tier already gets there."),
  rationale: z.string(),
});

type PlannedChange = z.infer<typeof ChangePlan>["changes"][number];
/** costSource is set after planning: "table" when priced from src/pricing, "estimate" when the model's own figure stands. */
export type ChangePlan = Omit<z.infer<typeof ChangePlan>, "changes"> & { changes: Array<PlannedChange & { costSource?: "table" | "estimate" }> };

export function tasteBrief(profile: TasteProfile): string {
  const total = profile.imageCount ?? 0;
  const rules = profile.categories.flatMap((category) =>
    category.rules.map((rule) => {
      const strength = total && !isStrongRule(rule, total) ? "weak" : "strong";
      return `- [${category.category}, ${strength}] ${rule.rule}`;
    }),
  );
  return [
    `Summary: ${profile.summary}`,
    `Era: ${profile.era}`,
    `Palette: walls ${profile.palette.walls.join(", ")}; wood ${profile.palette.woodTones.join(", ")}; metals ${profile.palette.metals.join(", ")}; accents ${profile.palette.accents.join(", ")}; ${profile.palette.contrast} contrast, ${profile.palette.saturation} saturation.`,
    "Rules (prefer strong over weak; weak rules are single-photo signals):",
    ...rules,
    ...(profile.expressions.length ? ["Expressions (pick one per room):", ...profile.expressions.map((e) => `- ${e.name}: ${e.description}`)] : []),
    `Avoid: ${[...profile.globalAvoid, ...profile.categories.flatMap((c) => c.avoid)].join("; ")}`,
  ].join("\n");
}

export function planPrompt(inventory: RoomInventory, profile: TasteProfile, tier: Tier, location?: string | null): string {
  return `You are planning a realistic interior redesign of one listing photo so a buyer can judge whether the house can be remodeled to their taste.

Tier: ${tier}
Allowed at this tier: ${TIER_DEFINITIONS[tier].allowed}

Hard constraints:
- Only change inventory items whose minTier is at or below "${tier}". Everything else goes in "preserve".
- Never move, resize, add, or remove window or door OPENINGS, skylights, stairs, or the ceiling plane, at any tier. Frames, sashes, casings, crown, baseboards, decorative coffers, and built-ins are components: change them at their tier when the taste calls for it, rather than preserving them by default.
- ${tier === "major" ? "You may remove interior walls from the inventory. Any wall marked possiblyLoadBearing must get a feasibility flag naming it. Plumbing relocations must be flagged." : "Do not remove or add walls, and do not move plumbing, appliances, or doorways."}
- Propose replacements a real contractor could source. Name materials and finishes.
- Apply the taste profile. Prefer strong rules; use weak rules only where nothing strong applies. Do not apply a rule that fights this room's architecture; flag it instead.
- Do not change things just to change them. If the existing item already fits the taste, preserve it.
${PRACTICAL_CONSTRAINTS.map((c) => `- ${c}`).join("\n")}
- Use the full allowance of this tier where the taste calls for it. When a change is allowed but carries uncertainty (e.g. whether coffers or soffits are structural), make the change and add a feasibility flag to verify it, rather than preserving the item. Reserve beyondScope for work above this tier.
- If this tier cannot reach the taste authentically, do the honest smaller version (or leave an item as-is) and put the real construction needed in beyondScope. Never render a cheaper change as if it were the full one (e.g. painted cabinets shown as new solid-wood cabinets).
- Choose one expression from the profile for this room (if it has any), based on the room's architecture and existing finishes, and keep every change consistent with it.
- Price each change against the cost table where one item fits: set costItem and measure quantity in that item's unit (count cabinet boxes, not linear feet; wall and ceiling paint is surface area, not floor area). The code computes the dollars for these from local unit costs. Use "other" only when nothing in the table fits.
- Cost table items: ${COST_ITEM_KEYS.map((k) => `${k} (${COST_ITEMS[k].label}, per ${COST_ITEMS[k].unit})`).join("; ")}.
- Still give your own costLow/costHigh for every change; it is used for "other" items and as a cross-check.
- Cost each change as an installed range (materials + labor, permits where typical) in ${new Date().getFullYear()} USD for ${location ? location : "a typical US metro"}. Estimate visible quantities from the photo (linear feet of cabinets, square feet of floor or tile, number of windows) and state them in costBasis. Price the specific materials proposed (e.g. solid wood vs. veneer vs. laminate, natural stone vs. quartz) at mid-market custom quality, not luxury designer pricing and not big-box. Keep ranges honest: high is typically 1.3–2× low. Cosmetic decor and furniture count at retail.
- First decide architecturalLanguage from what the existing room is (traditional, modern, vaulted, etc.), then choose finishes consistent with it. Where the taste offers conditional options ("in a traditional room… / in a modern room…"), pick the branch that fits this house.

Room inventory (JSON):
${JSON.stringify(inventory, null, 2)}

Taste profile:
${tasteBrief(profile)}
${roomNotesFor(profile, inventory.roomType)
  .map((room) => `\nSpecific direction for ${room.room} (prioritize this):\n${room.notes.map((n) => `- ${n}`).join("\n")}`)
  .join("\n")}`;
}

export async function planRedesign(input: {
  inventory: RoomInventory;
  profile: TasteProfile;
  tier: Tier;
  model: string;
  location?: string | null;
}): Promise<ChangePlan> {
  const plan = await generateStructured({
    model: input.model,
    prompt: planPrompt(input.inventory, input.profile, input.tier, input.location),
    schema: ChangePlan,
  });
  return priceChanges(enforceTier(plan, input.tier), input.location);
}

export type CostRange = { low: number; high: number };

/** Sum of a plan's change ranges, with each range sanitized (non-negative, low ≤ high). */
export function planCost(plan: Pick<ChangePlan, "changes">): CostRange | null {
  const ranges = plan.changes
    .filter((c) => Number.isFinite(c.costLow) && Number.isFinite(c.costHigh))
    .map((c) => ({ low: Math.max(0, Math.min(c.costLow, c.costHigh)), high: Math.max(0, c.costLow, c.costHigh) }));
  if (ranges.length === 0) return null;
  return ranges.reduce((a, r) => ({ low: a.low + r.low, high: a.high + r.high }), { low: 0, high: 0 });
}

/** Models occasionally overreach; drop anything above the tier rather than trusting the prompt. */
export function enforceTier(plan: ChangePlan, tier: Tier): ChangePlan {
  const kept = plan.changes.filter((change) => allowedAt(change.minTier, tier));
  const dropped = plan.changes.filter((change) => !allowedAt(change.minTier, tier));
  return {
    ...plan,
    tier,
    changes: kept,
    removedWalls: tier === "major" ? plan.removedWalls : [],
    preserve: [...plan.preserve, ...dropped.map((change) => change.element)],
    beyondScope: [...plan.beyondScope, ...dropped.map((c) => `${c.element}: ${c.proposed} (${c.minTier} tier)`)],
  };
}
