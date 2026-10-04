// Rough API cost model, calibrated against observed runs (gpt-6.1-sol text, gpt-image-2.5 high-quality edits).
// Used for the pre-run estimate and the per-run spend shown on past runs. These are estimates, not billing data.
export const API_COST = {
  inventory: 0.03, // one vision call per photo
  plan: 0.05, // one structured call per photo × scope
  attempt: 0.1, // image edit (~$0.08) + judge (~$0.02)
} as const;

export function estimateRunCost(photos: number, scopes: number): { low: number; high: number } {
  const redesigns = photos * scopes;
  const base = photos * API_COST.inventory + redesigns * API_COST.plan;
  return { low: base + redesigns * API_COST.attempt, high: base + redesigns * API_COST.attempt * 2 };
}

/** Minutes, from observed throughput: 3 photos in flight, ~1.5 min inventory + ~1.3 min per scope. */
export function estimateRunMinutes(photos: number, scopes: number): number {
  return Math.ceil(photos / 3) * (1.5 + scopes * 1.3);
}

export function spentOnRun(results: Array<{ tiers: Array<{ attempts: number; plan: { changes: unknown[] } }> }>): number {
  let total = 0;
  for (const photo of results) {
    total += API_COST.inventory;
    for (const t of photo.tiers) total += API_COST.plan + t.attempts * API_COST.attempt;
  }
  return total;
}
