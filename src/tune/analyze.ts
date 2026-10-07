// Pure scoring for `npm run tune`: threshold sweeps, per-element distributions, and per-model summaries.
import type { Verdict } from "../redesign/verify.js";

export type Label = "ok" | "broken";

/** One generated image (one attempt at one tier of one photo) from a past run. */
export type AttemptRecord = {
  /** listing/run/photo/tier/attempt — stable across re-scans, used as the label key. */
  key: string;
  listing: string;
  run: string;
  photo: string;
  tier: string;
  attempt: number;
  imageModel: string;
  /** Inventory and planning model when a comparison overrode the reasoning model; null for normal runs. */
  planner?: string | null;
  /** Wall-clock minutes for the whole run this attempt came from. Null when the run didn't finish. */
  runMinutes?: number | null;
  /** Verdict the pipeline gave this attempt when it ran. */
  verdict: Verdict;
  /** True for the attempt the run kept (the last one for its tier). */
  final: boolean;
  edges: Array<{ kind: string; correlation: number | null }>;
  /** The vision judge reported a structural change (element not preserved, openings, camera, or room size). */
  judgeBroken: boolean;
  planAdherence: number | null;
  /** Your own call on the image, from labels.json. Null when unlabeled. */
  label: Label | null;
  original: string;
  redesign: string;
};

export function minCorrelation(record: AttemptRecord): number | null {
  const values = record.edges.map((e) => e.correlation).filter((c): c is number => c !== null);
  return values.length ? Math.min(...values) : null;
}

/** Your label when there is one, else the vision judge's structural call. */
export function truth(record: AttemptRecord): Label {
  return record.label ?? (record.judgeBroken ? "broken" : "ok");
}

export function edgeFlags(record: AttemptRecord, threshold: number): boolean {
  return record.edges.some((e) => e.correlation !== null && e.correlation < threshold);
}

export type SweepRow = {
  threshold: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  /** Share of all attempts the edge check would flag. */
  flagged: number;
};

export function sweep(records: AttemptRecord[], thresholds: number[]): SweepRow[] {
  return thresholds.map((threshold) => {
    let [tp, fp, fn, tn] = [0, 0, 0, 0];
    for (const record of records) {
      const flagged = edgeFlags(record, threshold);
      const broken = truth(record) === "broken";
      if (flagged && broken) tp += 1;
      else if (flagged) fp += 1;
      else if (broken) fn += 1;
      else tn += 1;
    }
    const precision = tp + fp ? tp / (tp + fp) : null;
    const recall = tp + fn ? tp / (tp + fn) : null;
    const f1 = precision !== null && recall !== null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : null;
    return { threshold, tp, fp, fn, tn, precision, recall, f1, flagged: records.length ? (tp + fp) / records.length : 0 };
  });
}

/** Best F1; ties go to the lower threshold, which flags fewer images for review. Null without any broken examples. */
export function suggestThreshold(rows: SweepRow[]): SweepRow | null {
  let best: SweepRow | null = null;
  for (const row of rows) {
    if (row.f1 === null || row.tp + row.fn === 0) continue;
    if (!best || row.f1 > best.f1! + 1e-9) best = row;
  }
  return best;
}

export function thresholdRange(from = 0.2, to = 0.7, step = 0.05): number[] {
  const out: number[] = [];
  for (let t = from; t <= to + 1e-9; t += step) out.push(Math.round(t * 100) / 100);
  return out;
}

export function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export type KindStats = { kind: string; label: Label; n: number; p10: number | null; median: number | null; p90: number | null };

/** Correlation spread per fixed-element kind, split by whether the image was actually broken. */
export function kindStats(records: AttemptRecord[]): KindStats[] {
  const groups = new Map<string, number[]>();
  for (const record of records) {
    for (const edge of record.edges) {
      if (edge.correlation === null) continue;
      const key = `${edge.kind}\u0000${truth(record)}`;
      groups.set(key, [...(groups.get(key) ?? []), edge.correlation]);
    }
  }
  return [...groups.entries()]
    .map(([key, values]) => {
      const [kind, label] = key.split("\u0000") as [string, Label];
      const sorted = [...values].sort((a, b) => a - b);
      return { kind, label, n: sorted.length, p10: quantile(sorted, 0.1), median: quantile(sorted, 0.5), p90: quantile(sorted, 0.9) };
    })
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label));
}

export type ModelStats = {
  imageModel: string;
  /** Planner override shared by these runs; null for the default reasoning model. */
  planner: string | null;
  /** Median wall-clock minutes per run. Only comparable between runs of the same listing, photos and scopes. */
  medianRunMinutes: number | null;
  /** Tiers that produced an image (one per photo × tier). */
  tiers: number;
  verified: number;
  review: number;
  failed: number;
  /** Tiers verified on the first attempt. */
  firstTry: number;
  meanAttempts: number;
  meanPlanAdherence: number | null;
  /** Share of all attempts judged (or labeled) broken. */
  brokenRate: number;
};

export function modelStats(records: AttemptRecord[]): ModelStats[] {
  const byModel = new Map<string, AttemptRecord[]>();
  for (const record of records) {
    const key = `${record.imageModel}\u0000${record.planner ?? ""}`;
    byModel.set(key, [...(byModel.get(key) ?? []), record]);
  }
  return [...byModel.values()]
    .map((attempts) => {
      const { imageModel, planner = null } = attempts[0]!;
      const runMinutes = new Map(attempts.map((r) => [`${r.listing}/${r.run}`, r.runMinutes ?? null]));
      const minutes = [...runMinutes.values()].filter((n): n is number => n !== null).sort((a, b) => a - b);
      const finals = attempts.filter((r) => r.final);
      const adherence = attempts.map((r) => r.planAdherence).filter((n): n is number => n !== null);
      const count = (v: Verdict) => finals.filter((r) => r.verdict === v).length;
      return {
        imageModel,
        planner,
        medianRunMinutes: quantile(minutes, 0.5),
        tiers: finals.length,
        verified: count("verified"),
        review: count("review"),
        failed: count("failed"),
        firstTry: finals.filter((r) => r.attempt === 1 && r.verdict === "verified").length,
        meanAttempts: finals.length ? finals.reduce((s, r) => s + r.attempt, 0) / finals.length : 0,
        meanPlanAdherence: adherence.length ? adherence.reduce((s, n) => s + n, 0) / adherence.length : null,
        brokenRate: attempts.filter((r) => truth(r) === "broken").length / attempts.length,
      };
    })
    .sort((a, b) => a.imageModel.localeCompare(b.imageModel) || (a.planner ?? "").localeCompare(b.planner ?? ""));
}

const pct = (n: number | null) => (n === null ? "–" : `${Math.round(n * 100)}%`);
const num = (n: number | null, digits = 2) => (n === null ? "–" : n.toFixed(digits));

export function renderTuningReport(records: AttemptRecord[], current: number): string {
  if (records.length === 0) return "# Tuning report\n\nNo verified attempts found. Run a few redesigns first (`npm run redesign` or the app).\n";
  const labeled = records.filter((r) => r.label !== null).length;
  const rows = sweep(records, thresholdRange());
  const best = suggestThreshold(rows);
  const listings = new Set(records.map((r) => r.listing)).size;
  const runs = new Set(records.map((r) => `${r.listing}/${r.run}`)).size;
  const lines = [
    "# Tuning report",
    "",
    `${records.length} generated images from ${runs} runs across ${listings} listings. ${labeled} labeled by you; the rest use the vision judge's structural call as the answer.`,
    labeled < records.length ? "Labels are more trustworthy than the judge: run `npm run tune -- labels` and fill in `.runs/tuning/labels.json`." : "",
    "",
    "## Edge threshold",
    "",
    `An image is flagged when any fixed element's edge correlation falls below the threshold. Current threshold: **${current}**.`,
    "",
    "| Threshold | Flagged | Caught broken | False alarms | Missed broken | Precision | Recall | F1 |",
    "|---|---|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.threshold.toFixed(2)}${Math.abs(r.threshold - current) < 1e-9 ? " (current)" : ""}${best && r.threshold === best.threshold ? " ★" : ""} | ${pct(r.flagged)} | ${r.tp} | ${r.fp} | ${r.fn} | ${pct(r.precision)} | ${pct(r.recall)} | ${num(r.f1)} |`),
    "",
    best
      ? `★ Suggested: **${best.threshold.toFixed(2)}** (best F1). Apply it on the Tuning section of the app's Settings page, or set \`EDGE_THRESHOLD=${best.threshold.toFixed(2)}\` in \`.env.local\`.`
      : "No broken images yet, so there's nothing to tune against. Label a few failures or run more listings.",
    "",
    "## Correlation by element",
    "",
    "Where the broken and ok ranges overlap, the edge check can't separate them for that element.",
    "",
    "| Element | Answer | n | p10 | Median | p90 |",
    "|---|---|---|---|---|---|",
    ...kindStats(records).map((k) => `| ${k.kind} | ${k.label} | ${k.n} | ${num(k.p10)} | ${num(k.median)} | ${num(k.p90)} |`),
    "",
    "## Models",
    "",
    "Verdicts are for the image each run kept. Runs from before the image model was recorded show as `unknown`. Planner is the inventory and planning model (`default` on older runs, which used the reasoning model at medium effort). Run time only compares fairly between runs of the same listing, photos and scopes.",
    "",
    "| Image model | Planner | Run time | Tiers | Verified | Review | Failed | Verified first try | Mean attempts | Plan adherence | Broken (all attempts) |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...modelStats(records).map(
      (m) =>
        `| ${m.imageModel} | ${m.planner ?? "default"} | ${m.medianRunMinutes === null ? "–" : `${m.medianRunMinutes.toFixed(1)} min`} | ${m.tiers} | ${pct(m.tiers ? m.verified / m.tiers : null)} | ${pct(m.tiers ? m.review / m.tiers : null)} | ${pct(m.tiers ? m.failed / m.tiers : null)} | ${pct(m.tiers ? m.firstTry / m.tiers : null)} | ${num(m.meanAttempts, 1)} | ${num(m.meanPlanAdherence, 1)}/10 | ${pct(m.brokenRate)} |`,
    ),
    "",
  ];
  return lines.filter((line, i) => !(line === "" && lines[i - 1] === "")).join("\n");
}
