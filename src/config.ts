import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
    process.stderr.write(`[remodel-lens] Ignoring saved settings: ${(error as Error).message}\n`);
  }
}

export type Models = {
  /** Vision models that independently analyze each reference image. */
  analysis: string[];
  /** Fusion, rule extraction, inventory, planning, judging. */
  reasoning: string;
  /** OpenAI image edit model. */
  image: string;
};

export const DEFAULT_MODELS: Models = {
  analysis: ["openai/gpt-6.1-sol", "anthropic/claude-sonnet-5-5"],
  reasoning: "openai/gpt-6.1-sol",
  image: "gpt-image-2.5-sunburst",
};

export function resolveModels(): Models {
  return {
    analysis: (process.env.ANALYSIS_MODELS ?? DEFAULT_MODELS.analysis.join(","))
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean),
    reasoning: process.env.REASONING_MODEL ?? DEFAULT_MODELS.reasoning,
    image: process.env.IMAGE_MODEL ?? DEFAULT_MODELS.image,
  };
}

export function requireKeys(models: Models): void {
  const needed = new Set<string>(["OPENAI_API_KEY"]); // image edits always go through OpenAI
  for (const model of [...models.analysis, models.reasoning]) {
    if (model.startsWith("anthropic/")) needed.add("ANTHROPIC_API_KEY");
    if (model.startsWith("openai/")) needed.add("OPENAI_API_KEY");
  }
  const missing = [...needed].filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing ${missing.join(", ")}. Add ${missing.length > 1 ? "them" : "it"} on the app's Settings page, or in .env.local.`);
  }
}
