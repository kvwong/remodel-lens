// Read-only local analysis. No API calls, credentials, or listing names in output.
// Run: node scripts/cost-analysis.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const walk = dir => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true })
  .flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]) : [];
const runs = walk(path.join(root, '.runs/redesign')).filter(f => f.endsWith('/results.json'))
  .map(file => ({ date: path.basename(path.dirname(file)).slice(0, 10), photos: JSON.parse(fs.readFileSync(file, 'utf8')) }))
  .filter(r => Array.isArray(r.photos));
function aggregate(input) {
  const photos = input.flatMap(r => r.photos), tiers = photos.flatMap(p => p.tiers ?? []);
  const count = status => tiers.filter(t => t.status === status).length;
  const attempts = tiers.reduce((sum, t) => sum + (t.attempts ?? 0), 0);
  const generated = tiers.filter(t => t.attempts > 0).length;
  const delivered = count('verified') + count('review');
  const legacyApiEstimate = photos.length * .03 + tiers.length * .05 + attempts * .10;
  return { runs: input.length, photos: photos.length, scopes: tiers.length, attempts,
    generated, retried: tiers.filter(t => t.attempts > 1).length,
    statuses: Object.fromEntries(['verified', 'review', 'failed', 'error', 'unchanged'].map(s => [s, count(s)])),
    attemptsPerGeneratedScope: generated ? attempts / generated : null,
    failedRate: tiers.length ? count('failed') / tiers.length : null,
    legacyApiEstimate, legacyApiEstimatePerDelivered: delivered ? legacyApiEstimate / delivered : null };
}
const assumptions = {
  currency: 'USD', paymentPercent: .029, paymentFixed: .30,
  variableCostPerConsumedCredit: { low: .35, base: .60, stress: .90 },
  fixedMonthlyOperatingCost: 150,
  note: 'Scenario allowances, not measured bills. Full redemption; no breakage. Variable cost includes failed-output absorption and a modest operations reserve. Excludes founder labor, acquisition, taxes, and exceptional support.',
};
const packs = [{ price: 19, credits: 10 }, { price: 49, credits: 30 }, { price: 99, credits: 65 }].map(pack => {
  const payment = pack.price * assumptions.paymentPercent + assumptions.paymentFixed;
  return { ...pack, pricePerCredit: pack.price / pack.credits, payment,
    scenarios: Object.fromEntries(Object.entries(assumptions.variableCostPerConsumedCredit).map(([name, cost]) => {
      const contribution = pack.price - payment - pack.credits * cost;
      return [name, { variableCost: pack.credits * cost, contribution,
        contributionMargin: contribution / pack.price,
        ordersToCoverFixedCost: contribution > 0 ? Math.ceil(assumptions.fixedMonthlyOperatingCost / contribution) : null }];
    })) };
});
const home = { photos: 10, scopes: 3, tasteReferenceImages: 10, revisions: 5 };
const homeCredits = home.photos * home.scopes + 5 * Math.ceil(home.tasteReferenceImages / 10) + home.revisions;
console.log(JSON.stringify({ assumptions, observed: { all: aggregate(runs), since20261006: aggregate(runs.filter(r => r.date >= '2026-10-06')) }, packs,
  homeExample: { ...home, credits: homeCredits, legacyApiEstimateLow: .03 * home.photos + .05 * home.photos * home.scopes + .10 * home.photos * home.scopes,
    legacyApiEstimateHigh: .03 * home.photos + .05 * home.photos * home.scopes + .20 * home.photos * home.scopes,
    variableCostAllowance: homeCredits * assumptions.variableCostPerConsumedCredit.base },
  monthly49DollarOrders: [100, 500, 1000].map(orders => ({ orders, revenue: orders * 49,
    contributionAfterFixed: orders * packs[1].scenarios.base.contribution - assumptions.fixedMonthlyOperatingCost,
    stressContributionAfterFixed: orders * packs[1].scenarios.stress.contribution - assumptions.fixedMonthlyOperatingCost })) }, null, 2));
