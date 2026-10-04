import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
}

export type Models = {
  /** Vision models that independently analyze each reference image. */
  analysis: string[];
  /** Fusion, rule extraction, inventory, planning, judging. */
  reasoning: string;
  /** OpenAI image edit model. */
  image: string;
};

export function resolveModels(): Models {
  return {
    analysis: (process.env.ANALYSIS_MODELS ?? "openai/gpt-6.1-sol,anthropic/claude-sonnet-5-5")
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean),
    reasoning: process.env.REASONING_MODEL ?? "openai/gpt-6.1-sol",
    image: process.env.IMAGE_MODEL ?? "gpt-image-2.5-sunburst",
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
    throw new Error(`Missing ${missing.join(", ")}. Copy .env.example to .env.local and fill it in.`);
  }
}
