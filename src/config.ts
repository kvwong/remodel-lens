import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseEffort, withEffort, type Effort } from "./effort.js";
import { applySettings, readSettings } from "./settings.js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function loadEnv(): void {
  for (const file of [".env.local", ".env"]) {
    const full = path.join(ROOT, file);
    if (!existsSync(full)) continue;
    for (const line of readFileSync(full, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!match || match[2] === "" || process.env[match[1]!]) continue;
      process.env[match[1]!] = match[2]!.replace(/^(['"])(.*)\1$/, "$2");
    }
  }
  // Values saved on the app's settings page win over the files above.
  try {
    applySettings(readSettings());
  } catch (error) {
    process.stderr.write(`[whim] Ignoring saved settings: ${(error as Error).message}\n`);
  }
}

export type Models = {
  /** Vision models that independently analyze each reference image. */
  analysis: string[];
  /** Fusion, rule extraction, inventory, planning, judging. Resolved ids carry their effort, e.g. openai/gpt-6.1-sol:low. */
  reasoning: string;
  /** Overrides reasoning for room inventory and redesign planning only (PLANNER_MODEL, or `npm run tune -- compare --planners`). */
  planner?: string;
  /** OpenAI image edit model. */
  image: string;
};

export const DEFAULT_MODELS: Models = {
  analysis: ["openai/gpt-6.1-sol", "anthropic/claude-sonnet-5-5"],
  reasoning: "openai/gpt-6.1-sol",
  image: "gpt-image-2.5-sunburst",
};

/**
 * Reasoning effort when Settings (REASONING_EFFORT, ANALYSIS_EFFORT) and the model id don't name one. Low for reasoning:
 * on a Talus test (2026-10-07) it planned 18% faster with no loss in verified redesigns.
 */
export const DEFAULT_EFFORT: { reasoning: Effort; analysis: Effort } = { reasoning: "low", analysis: "medium" };

export function resolveModels(): Models {
  const reasoningEffort = parseEffort(process.env.REASONING_EFFORT) ?? DEFAULT_EFFORT.reasoning;
  const analysisEffort = parseEffort(process.env.ANALYSIS_EFFORT) ?? DEFAULT_EFFORT.analysis;
  const reasoning = withEffort(process.env.REASONING_MODEL ?? DEFAULT_MODELS.reasoning, reasoningEffort);
  return {
    analysis: (process.env.ANALYSIS_MODELS ?? DEFAULT_MODELS.analysis.join(","))
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean)
      .map((m) => withEffort(m, analysisEffort)),
    reasoning,
    ...(process.env.PLANNER_MODEL ? { planner: process.env.PLANNER_MODEL } : {}),
    image: process.env.IMAGE_MODEL ?? DEFAULT_MODELS.image,
  };
}

export function requireKeys(models: Models): void {
  const needed = new Set<string>(["OPENAI_API_KEY"]); // image edits always go through OpenAI
  for (const model of [...models.analysis, models.reasoning, ...(models.planner ? [models.planner] : [])]) {
    if (model.startsWith("anthropic/")) needed.add("ANTHROPIC_API_KEY");
    if (model.startsWith("openai/")) needed.add("OPENAI_API_KEY");
  }
  const missing = [...needed].filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing ${missing.join(", ")}. Add ${missing.length > 1 ? "them" : "it"} on the app's Settings page, or in .env.local.`);
  }
}
