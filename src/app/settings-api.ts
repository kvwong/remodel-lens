// Server side of the settings page: what the page shows, saving edits, checking keys, and the tuning tool.
import path from "node:path";
import { z } from "zod";

import { DEFAULT_MODELS, requireKeys, resolveModels } from "../config.js";
import { DEFAULT_COST_ASSUMPTIONS } from "../pricing/assumptions.js";
import { COST_ITEM_KEYS, COST_ITEMS, REGIONS } from "../pricing/catalog.js";
import { DEFAULT_IMAGE_CONCURRENCY, imageConcurrency } from "../redesign/generate.js";
import { RUNS_DIR } from "../redesign/job.js";
import { EDGE_THRESHOLD, edgeThreshold } from "../redesign/verify.js";
import { currentSettings, environmentValue, maskKey, saveSettings, type Settings } from "../settings.js";
import { edgeFlags, minCorrelation, modelStats, suggestThreshold, sweep, thresholdRange, type AttemptRecord } from "../tune/analyze.js";
import { collectAttempts, LABELS_FILE, readLabels, setLabel } from "../tune/collect.js";

export const PROVIDERS = {
  openai: { name: "OpenAI", env: "OPENAI_API_KEY", url: "https://platform.openai.com/api-keys" },
  anthropic: { name: "Anthropic", env: "ANTHROPIC_API_KEY", url: "https://console.anthropic.com/settings/keys" },
} as const;
type Provider = keyof typeof PROVIDERS;

export const MODEL_OPTIONS = {
  reasoning: [
    { id: "openai/gpt-6.1-sol", label: "GPT-6.1 Sol", note: "OpenAI." },
    { id: "anthropic/claude-sonnet-5-5", label: "Claude Sonnet 5.5", note: "Anthropic." },
    { id: "anthropic/claude-opus-5-5", label: "Claude Opus 5.5", note: "Anthropic. Most capable, slower and pricier." },
  ],
  image: [
    { id: "gpt-image-2.5-sunburst", label: "gpt-image-2.5-sunburst", note: "Most precise edits." },
    { id: "gpt-image-2.5-flare", label: "gpt-image-2.5-flare", note: "Same price, faster, less precise." },
    { id: "gpt-image-2", label: "gpt-image-2", note: "Older. Edits through a mask." },
  ],
};

function keyView(provider: Provider, settings: Settings) {
  const saved = settings.keys[provider];
  const env = environmentValue(PROVIDERS[provider].env);
  return {
    name: PROVIDERS[provider].name,
    url: PROVIDERS[provider].url,
    source: saved ? "settings" : env ? "environment" : null,
    hint: maskKey(saved ?? env),
  };
}

export function settingsView() {
  const settings = currentSettings();
  const models = resolveModels();
  let keysError: string | null = null;
  try {
    requireKeys(models);
  } catch (error) {
    keysError = (error as Error).message;
  }
  return {
    keys: { openai: keyView("openai", settings), anthropic: keyView("anthropic", settings) },
    keysError,
    models: {
      current: models,
      saved: settings.models,
      defaults: DEFAULT_MODELS,
      options: MODEL_OPTIONS,
      imageConcurrency: { current: imageConcurrency(), default: DEFAULT_IMAGE_CONCURRENCY },
    },
    tuning: { edgeThreshold: edgeThreshold(), saved: settings.tuning.edgeThreshold ?? null, default: EDGE_THRESHOLD },
    costs: {
      saved: settings.costs,
      defaults: { laborFactor: DEFAULT_COST_ASSUMPTIONS.laborFactor, grades: DEFAULT_COST_ASSUMPTIONS.grades, overhead: DEFAULT_COST_ASSUMPTIONS.overhead },
      regions: { seattle: { name: REGIONS.seattle.name, source: REGIONS.seattle.source }, national: { name: REGIONS.national.name, source: REGIONS.national.source } },
      items: COST_ITEM_KEYS.map((key) => {
        const item = COST_ITEMS[key];
        return { key, label: item.label, unit: item.unit, low: item.low, high: item.high, laborShare: item.laborShare, source: item.source };
      }),
    },
  };
}

const Clearable = <T extends z.ZodType>(schema: T) => schema.nullable().optional();
export const SettingsPatch = z.object({
  keys: z.object({ openai: Clearable(z.string().trim().max(500)), anthropic: Clearable(z.string().trim().max(500)) }).optional(),
  models: z
    .object({
      reasoning: Clearable(z.string().trim().max(100)),
      analysis: Clearable(z.array(z.string().trim().max(100)).max(4)),
      image: Clearable(z.string().trim().max(100)),
      imageConcurrency: Clearable(z.number()),
    })
    .optional(),
  tuning: z.object({ edgeThreshold: Clearable(z.number()) }).optional(),
  /** Replaces all cost assumptions at once; null goes back to the built-in table. */
  costs: Clearable(z.unknown()),
});

/** undefined keeps the saved value, null or "" clears it, anything else replaces it. */
function merge<T extends Record<string, unknown>>(saved: T, patch: Record<string, unknown> | undefined): T {
  const next: Record<string, unknown> = { ...saved };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value === undefined) continue;
    if (value === null || value === "") delete next[key];
    else next[key] = value;
  }
  return next as T;
}

export async function updateSettings(body: unknown) {
  const patch = SettingsPatch.parse(body);
  const saved = currentSettings();
  const next = {
    keys: merge(saved.keys, patch.keys),
    models: merge(saved.models, patch.models),
    tuning: merge(saved.tuning, patch.tuning),
    costs: patch.costs === undefined ? saved.costs : (patch.costs ?? {}),
  };
  try {
    await saveSettings(next as Settings);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issue = error.issues[0];
      throw Object.assign(new Error(`${issue?.path.join(" › ") || "Settings"}: ${issue?.message ?? "invalid"}`), { status: 400 });
    }
    throw error;
  }
  return settingsView();
}

/** Lists models with the key: free, and proves the key is live without spending anything. */
export async function testKey(provider: Provider, typed?: string): Promise<{ ok: boolean; message: string }> {
  const key = typed?.trim() || process.env[PROVIDERS[provider].env];
  if (!key) return { ok: false, message: "No key to check yet." };
  const request: { url: string; headers: Record<string, string> } =
    provider === "openai"
      ? { url: "https://api.openai.com/v1/models", headers: { authorization: `Bearer ${key}` } }
      : { url: "https://api.anthropic.com/v1/models", headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } };
  try {
    const res = await fetch(request.url, { headers: request.headers, signal: AbortSignal.timeout(10_000) });
    if (res.ok) return { ok: true, message: `${PROVIDERS[provider].name} accepted this key.` };
    if (res.status === 401 || res.status === 403) return { ok: false, message: `${PROVIDERS[provider].name} rejected this key.` };
    return { ok: false, message: `${PROVIDERS[provider].name} answered with an error (${res.status}). Try again in a moment.` };
  } catch {
    return { ok: false, message: `Couldn't reach ${PROVIDERS[provider].name}. Check the internet connection.` };
  }
}

/* ---------- Tuning ---------- */

let scanned: { at: string; records: AttemptRecord[] } | null = null;

const runUrl = (file: string, kind: "thumb" | "files") =>
  `/${kind}/runs/${path.relative(RUNS_DIR, file).split(path.sep).map(encodeURIComponent).join("/")}${kind === "thumb" ? "?w=480" : ""}`;

/** Re-scores past runs from disk (no API calls). Cached until the page asks for a rescan. */
export async function tuningView(rescan: boolean) {
  if (!scanned || rescan) {
    scanned = { at: new Date().toISOString(), records: await collectAttempts(RUNS_DIR, { labels: await readLabels(LABELS_FILE) }) };
  }
  const { records } = scanned;
  const threshold = edgeThreshold();
  const rows = sweep(records, thresholdRange());
  return {
    scannedAt: scanned.at,
    threshold,
    total: records.length,
    labeled: records.filter((r) => r.label !== null).length,
    runs: new Set(records.map((r) => `${r.listing}/${r.run}`)).size,
    listings: new Set(records.map((r) => r.listing)).size,
    sweep: rows,
    suggested: suggestThreshold(rows),
    models: modelStats(records),
    attempts: records.map((r) => ({
      key: r.key,
      listing: r.listing,
      photo: r.photo,
      tier: r.tier,
      attempt: r.attempt,
      imageModel: r.imageModel,
      verdict: r.verdict,
      judge: r.judgeBroken ? "broken" : "ok",
      label: r.label,
      minCorrelation: minCorrelation(r),
      flagged: edgeFlags(r, threshold),
      original: { thumb: runUrl(r.original, "thumb"), full: runUrl(r.original, "files") },
      redesign: { thumb: runUrl(r.redesign, "thumb"), full: runUrl(r.redesign, "files") },
    })),
  };
}

export async function labelAttempt(key: string, label: "ok" | "broken" | null) {
  if (!scanned) await tuningView(false);
  const record = scanned!.records.find((r) => r.key === key);
  if (!record) throw Object.assign(new Error("That image is no longer in your runs. Rescan and try again."), { status: 404 });
  await setLabel(LABELS_FILE, record, label);
  record.label = label;
  return tuningView(false);
}
