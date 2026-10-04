import { z } from "zod";

// Structured-output friendly: every field required, nullable instead of optional.

export const TASTE_CATEGORIES = [
  "walls_ceilings",
  "flooring",
  "cabinetry_millwork",
  "countertops_surfaces",
  "tile_backsplash",
  "lighting",
  "hardware_fixtures",
  "furniture",
  "textiles_soft_goods",
  "decor_density",
  "layout_openness",
] as const;

export const TasteCategory = z.enum(TASTE_CATEGORIES);

export const TasteRule = z.object({
  rule: z.string().describe("One concrete, imperative, implementable rule."),
  support: z.number().int().describe("How many reference images show evidence for this rule."),
  fromBrief: z.boolean().describe("True if the owner's written brief states this rule. Brief rules count as strong even with low image support."),
});

export const TasteProfile = z.object({
  summary: z.string().describe("Two or three sentences in concrete terms, no unsupported praise words."),
  era: z.string().describe("Period or era leaning, e.g. 'mid-century bones with contemporary finishes'."),
  palette: z.object({
    walls: z.array(z.string()),
    woodTones: z.array(z.string()),
    metals: z.array(z.string()),
    accents: z.array(z.string()),
    contrast: z.enum(["low", "medium", "high"]),
    saturation: z.enum(["muted", "moderate", "bold"]),
  }),
  categories: z.array(
    z.object({
      category: TasteCategory,
      rules: z.array(TasteRule),
      avoid: z.array(z.string()),
    }),
  ),
  expressions: z
    .array(z.object({ name: z.string(), description: z.string() }))
    .describe("Named alternative directions within the taste (e.g. 'calm and earthy' vs 'quietly playful'). Each room uses one. Empty if the taste has a single direction."),
  globalAvoid: z.array(z.string()),
  roomNotes: z.array(z.object({ room: z.string(), notes: z.array(z.string()) })),
  imagePromptSummary: z
    .string()
    .describe("80–120 words of comma-dense visual direction for an image model: materials, colors, finishes, shapes."),
});

export type TasteProfile = z.infer<typeof TasteProfile> & { imageCount?: number };
export type TasteRule = z.infer<typeof TasteRule>;
