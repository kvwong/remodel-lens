// Gathers every verified attempt from past redesign runs, re-scoring edges from the saved images so changes to
// the edge check apply to old runs without new API calls.
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import type { RoomInventory } from "../listing/inventory.js";
import type { RunSummary } from "../redesign/job.js";
import { edgeChecks, type EdgeCheck, type JudgeResult, type Verdict } from "../redesign/verify.js";
import type { AttemptRecord, Label } from "./analyze.js";
import { minCorrelation } from "./analyze.js";

type SavedVerify = { verdict: Verdict; edges: EdgeCheck[]; judgement: JudgeResult };

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

async function dirs(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

export function judgeBroken(judgement: JudgeResult): boolean {
  return judgement.fixedChecks.some((c) => !c.preserved) || judgement.openingsChanged || judgement.cameraChanged || judgement.roomSizeChanged;
}

/** Scans runsDir/<listing>/<run>/<photo>/<tier>/verify-N.json. `only` limits to "listing/run" ids. */
export async function collectAttempts(runsDir: string, options: { only?: Set<string>; labels?: Record<string, Label | null> } = {}): Promise<AttemptRecord[]> {
  const records: AttemptRecord[] = [];
  for (const listing of await dirs(runsDir)) {
    for (const run of await dirs(path.join(runsDir, listing))) {
      if (options.only && !options.only.has(`${listing}/${run}`)) continue;
      const runDir = path.join(runsDir, listing, run);
      const summary = await readJson<RunSummary>(path.join(runDir, "run.json"));
      for (const photo of await dirs(runDir)) {
        const inventory = await readJson<RoomInventory>(path.join(runDir, photo, "inventory.json"));
        const originalPath = path.join(runDir, photo, "original.png");
        const original = existsSync(originalPath) ? await readFile(originalPath) : null;
        for (const tier of await dirs(path.join(runDir, photo))) {
          const tierDir = path.join(runDir, photo, tier);
          const attempts = (await readdir(tierDir))
            .map((name) => /^verify-(\d+)\.json$/.exec(name)?.[1])
            .filter((n): n is string => n !== undefined)
            .map(Number)
            .sort((a, b) => a - b);
          for (const attempt of attempts) {
            const saved = await readJson<SavedVerify>(path.join(tierDir, `verify-${attempt}.json`));
            if (!saved?.judgement) continue;
            const redesignPath = path.join(tierDir, `redesign-${attempt}.png`);
            let edges = saved.edges;
            if (original && inventory && existsSync(redesignPath)) {
              edges = await edgeChecks(original, await readFile(redesignPath), inventory, 0);
            }
            const key = [listing, run, photo, tier, attempt].join("/");
            records.push({
              key,
              listing,
              run,
              photo,
              tier,
              attempt,
              imageModel: summary?.imageModel ?? "unknown",
              verdict: saved.verdict,
              final: attempt === attempts[attempts.length - 1],
              edges: edges.map((e) => ({ kind: e.kind, correlation: e.correlation })),
              judgeBroken: judgeBroken(saved.judgement),
              planAdherence: saved.judgement.planAdherence ?? null,
              label: options.labels?.[key] ?? null,
              original: originalPath,
              redesign: redesignPath,
            });
          }
        }
      }
    }
  }
  return records;
}

const round = (n: number | null) => (n === null ? null : Math.round(n * 100) / 100);

export type LabelEntry = { label: Label | null; judge: Label; minCorrelation: number | null; original: string; redesign: string };

export async function readLabels(file: string): Promise<Record<string, Label | null>> {
  const raw = (await readJson<Record<string, Partial<LabelEntry>>>(file)) ?? {};
  const out: Record<string, Label | null> = {};
  for (const [key, entry] of Object.entries(raw)) {
    out[key] = entry?.label === "ok" || entry?.label === "broken" ? entry.label : null;
  }
  return out;
}

/** Adds an entry for every attempt not yet in the file; keeps labels you've already filled in. */
export async function writeLabelTemplate(file: string, records: AttemptRecord[]): Promise<{ added: number; total: number }> {
  const existing = (await readJson<Record<string, LabelEntry>>(file)) ?? {};
  let added = 0;
  for (const record of records) {
    if (existing[record.key]) continue;
    existing[record.key] = {
      label: null,
      judge: record.judgeBroken ? "broken" : "ok",
      minCorrelation: round(minCorrelation(record)),
      original: record.original,
      redesign: record.redesign,
    };
    added += 1;
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(existing, null, 2)}\n`);
  return { added, total: Object.keys(existing).length };
}
