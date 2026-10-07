// Settings saved from the app's settings page: API keys, models, the edge threshold, and cost assumptions.
// Stored in .settings.json at the repo root (git-ignored, owner-only permissions). Anything set here wins over
// .env.local and the shell environment; clearing a field falls back to those again.
import { existsSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { EFFORTS } from "./effort.js";
import { setCostOverrides } from "./pricing/assumptions.js";
import { COST_ITEMS, GRADES } from "./pricing/catalog.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SETTINGS_FILE = path.join(ROOT, ".settings.json");

const ModelId = z.string().trim().regex(/^(openai|anthropic)\/[\w.:-]+$/, "Use an openai/… or anthropic/… model id.");
const Factor = z.number().finite().gt(0).max(10);
const UnitCost = z.object({ low: z.number().finite().min(0), high: z.number().finite().min(0) }).refine((c) => c.high >= c.low, "High must be at least low.");

export const Settings = z.object({
  keys: z.object({ openai: z.string().optional(), anthropic: z.string().optional() }).default({}),
  models: z
    .object({
      reasoning: ModelId.optional(),
      analysis: z.array(ModelId).min(1).max(4).optional(),
      image: z.string().trim().regex(/^[\w.:-]+$/).max(100).optional(),
      imageConcurrency: z.number().int().min(1).max(16).optional(),
      reasoningEffort: z.enum(EFFORTS).optional(),
      analysisEffort: z.enum(EFFORTS).optional(),
    })
    .default({}),
  tuning: z.object({ edgeThreshold: z.number().gt(0).lt(1).optional() }).default({}),
  costs: z
    .object({
      laborFactor: z.object({ seattle: Factor.optional(), national: Factor.optional() }).optional(),
      grades: z.object(Object.fromEntries(GRADES.map((g) => [g, Factor.optional()])) as Record<(typeof GRADES)[number], z.ZodOptional<typeof Factor>>).optional(),
      overhead: z.number().finite().min(0).max(2).optional(),
      items: z.partialRecord(z.enum(Object.keys(COST_ITEMS) as [keyof typeof COST_ITEMS, ...Array<keyof typeof COST_ITEMS>]), UnitCost).optional(),
    })
    .default({}),
});
export type Settings = z.infer<typeof Settings>;

/** Environment variables each setting stands in for. */
const ENV = {
  OPENAI_API_KEY: (s: Settings) => s.keys.openai,
  ANTHROPIC_API_KEY: (s: Settings) => s.keys.anthropic,
  REASONING_MODEL: (s: Settings) => s.models.reasoning,
  ANALYSIS_MODELS: (s: Settings) => s.models.analysis?.join(","),
  IMAGE_MODEL: (s: Settings) => s.models.image,
  REASONING_EFFORT: (s: Settings) => s.models.reasoningEffort,
  ANALYSIS_EFFORT: (s: Settings) => s.models.analysisEffort,
  IMAGE_CONCURRENCY: (s: Settings) => (s.models.imageConcurrency === undefined ? undefined : String(s.models.imageConcurrency)),
  EDGE_THRESHOLD: (s: Settings) => (s.tuning.edgeThreshold === undefined ? undefined : String(s.tuning.edgeThreshold)),
} as const;
export type EnvName = keyof typeof ENV;

/** What the environment held before any saved setting replaced it, so clearing a setting restores it. */
let baseEnv: Partial<Record<EnvName, string | undefined>> | null = null;
let current: Settings = Settings.parse({});

export function readSettings(file = SETTINGS_FILE): Settings {
  if (!existsSync(file)) return Settings.parse({});
  try {
    return Settings.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch (error) {
    throw new Error(`${path.basename(file)} is not valid (${error instanceof Error ? error.message : String(error)}). Fix or delete it.`);
  }
}

export function currentSettings(): Settings {
  return current;
}

/** The value from .env.local or the shell, ignoring the settings page. */
export function environmentValue(name: EnvName): string | undefined {
  return (baseEnv ? baseEnv[name] : process.env[name]) || undefined;
}

export function applySettings(settings: Settings): void {
  if (!baseEnv) baseEnv = Object.fromEntries(Object.keys(ENV).map((name) => [name, process.env[name]]));
  for (const [name, pick] of Object.entries(ENV) as Array<[EnvName, (s: Settings) => string | undefined]>) {
    const value = pick(settings) || baseEnv[name];
    if (value) process.env[name] = value;
    else delete process.env[name];
  }
  setCostOverrides(settings.costs);
  current = settings;
}

export async function saveSettings(settings: Settings, file = SETTINGS_FILE): Promise<Settings> {
  const parsed = Settings.parse(settings);
  const tmp = `${file}.${process.pid}.tmp`;
  // Owner-only: the file holds API keys.
  await writeFile(tmp, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
  applySettings(parsed);
  return parsed;
}

/** Enough of a key to recognize it, never enough to use it. */
export function maskKey(key: string | undefined): string | null {
  if (!key) return null;
  return key.length >= 16 ? `…${key.slice(-4)}` : "…";
}
