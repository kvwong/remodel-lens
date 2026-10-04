export const TIERS = ["cosmetic", "moderate", "major"] as const;
export type Tier = (typeof TIERS)[number];

/** User-facing names. Internal ids stay cosmetic/moderate/major so saved runs keep working. */
export const TIER_LABELS: Record<Tier, { name: string; blurb: string }> = {
  cosmetic: { name: "Cosmetic", blurb: "Paint, lighting, furniture" },
  moderate: { name: "Finishes", blurb: "Cabinets, counters, floors, trim" },
  major: { name: "Structural", blurb: "Windows, ceilings, walls" },
};

export const TIER_RANK: Record<Tier, number> = { cosmetic: 0, moderate: 1, major: 2 };

export const TIER_DEFINITIONS: Record<Tier, { allowed: string; confidence: string }> = {
  cosmetic: {
    allowed:
      "paint (walls, ceiling, trim, cabinets), light fixtures swapped in the same locations, furniture, rugs, decor, window treatments, cabinet and door hardware, refinishing existing wood floors, mirrors",
    confidence: "Strong evidence: these changes rarely surprise anyone on cost or feasibility.",
  },
  moderate: {
    allowed:
      "everything in cosmetic, plus new flooring, new cabinet boxes and doors in the same layout, countertops, backsplash and wall tile, plumbing fixtures in the same locations, appliances in the same locations, interior doors, adding, removing, or replacing trim (window and door casings, crown, baseboards), and rebuilding built-ins without changing walls",
    confidence: "Good evidence with a real budget: layout and openings are unchanged.",
  },
  major: {
    allowed:
      "everything in moderate, plus replacing window and exterior door frames and sashes within the existing openings (same position and size), adding or removing decorative non-structural coffers, beams, and soffits, removing or adding interior non-exterior walls, relocating plumbing and the kitchen layout, islands requiring new plumbing or electrical, enlarging interior openings",
    confidence:
      "Speculative: wall removal and plumbing moves need a contractor and possibly a structural engineer before you rely on this.",
  },
};

export function allowedAt(required: Tier, tier: Tier): boolean {
  return TIER_RANK[required] <= TIER_RANK[tier];
}

export function parseTiers(value: string | undefined): Tier[] {
  if (!value) return ["cosmetic", "moderate"];
  const tiers = value.split(",").map((t) => t.trim());
  for (const tier of tiers) {
    if (!(TIERS as readonly string[]).includes(tier)) {
      throw new Error(`Unknown tier "${tier}". Use ${TIERS.join(", ")}.`);
    }
  }
  return tiers as Tier[];
}
