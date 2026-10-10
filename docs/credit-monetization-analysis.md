# Whim cost and credit monetization analysis

Prepared October 9, 2026 (America/Los_Angeles). Proposal only; billing is not implemented.

Whim can plausibly monetize through prepaid credits. Launch around personalized home exploration: consistent taste across rooms, cosmetic/moderate/major scopes, architecture checks, revision tools, and a shareable cost report. Start with one-time purchases because home buying and remodeling are episodic. Test repeat-use subscriptions with agents after establishing demand.

## What was measured

Read-only review of `src/costs.ts`, `src/config.ts`, `src/providers.ts`, `src/taste/pipeline.ts`, `src/redesign/run.ts`, `src/redesign/generate.ts`, `src/redesign/change.ts`, and the local server. Aggregate results from 19 saved redesign runs; no new paid API calls. Run `node scripts/cost-analysis.mjs` to reproduce the calculations against the current local artifacts. Private listing identifiers are omitted from the output and this report.

| Metric | All saved completed results | Results dated October 6 onward |
| --- | ---: | ---: |
| Runs | 19 | 8 |
| Photo inputs across runs | 186 | 86 |
| Requested photo × scope outputs | 315 | 154 |
| Image attempts recorded in results | 421 | 187 |
| Outputs requiring a second attempt | 106 (33.7%) | 33 (21.4%) |
| Final verified | 142 | 81 |
| Final needs review | 117 | 62 |
| Final failed | 56 (17.8%) | 11 (7.1%) |
| Attempts per requested output | 1.34 | 1.21 |

This is development data with repeated houses, model/threshold tuning, and overlapping runs; it does not prove customer acceptance or improving production quality. Recent dates use the UTC run-folder timestamp, not a local-day boundary. Result files omit incomplete/orphaned work and provider transport retries. Revisions are a separate workflow and are excluded from these counts. “Needs review” is not verified: treating it as billable below assumes explicit customer acceptance. Ten saved run metadata files identify Sunburst; other metadata are unknown, so the pooled sample is not a controlled Sunburst benchmark.

## Current cost estimate versus commercial budget

The application uses $0.03 for inventory per photo, $0.05 for planning per scope, and $0.10 for each image-plus-judge attempt. This produces $63.43 across the sample, or $0.245 per verified/review output after absorbing failed scopes; the recent subset is $0.203. These are estimates generated from constants, not invoice evidence.

For P photos and S scopes, its low/high run estimate is:

`0.03P + 0.05PS + 0.10PS × (1 to 2 attempts)`

Ten photos × three scopes therefore shows $4.80–$7.80 for the initial redesign run. That excludes taste building, customer revisions, unrecorded failed work, storage, payment fees, and support.

The default image model is `gpt-image-2.5-sunburst`, with `quality: high`, `size: auto`, and one output. The default language models are GPT-6.1 Sol and Claude Sonnet 5.5, with low reasoning effort and medium reference-analysis effort unless overridden. Text helpers discard usage; image helpers discard image usage. There is no reliable token-to-invoice reconciliation today.

[Official OpenAI pricing](https://developers.openai.com/api/docs/pricing) lists standard Sunburst image input at $8/M tokens, output at $30/M, and text input at $5/M. Thus the image cost is `(8 × image-input-tokens + 30 × image-output-tokens + 5 × text-input-tokens) / 1,000,000`, with cached inputs charged at their applicable rates. Standard short-context GPT-6.1 Sol is $2/M input and $10/M output. Reasoning tokens and image inputs matter. These token rates do not establish a fixed per-edit price.

The [image generation guide](https://developers.openai.com/api/docs/guides/image-generation) quotes high-quality GPT Image 2 output examples around $0.165–$0.211, before inputs. That is a comparison model, not a verified Sunburst per-image quote. It is enough to question the repository's $0.08 image component, but cannot replace actual Sunburst usage measurements.

Use three provisional **variable-cost allowances per consumed credit**:

| Scenario | Cost | Interpretation |
| --- | ---: | --- |
| Lower | $0.35 | Efficient generation, low support, limited retries |
| Planning base | $0.60 | Higher image expense plus retries/failures and operations reserve |
| Stress | $0.90 | Higher inputs/resolution, rejection, revisions, or support load |

An illustrative base bridge: $0.03 inventory + $0.05 plan + 1.34 attempts × $0.25 for edit/verification = $0.415 per request; divide by 82.2% nonfailed output rate = $0.505 per delivered output; add $0.095 for variable storage, operations, and exceptional retry expense = $0.60. The $0.25 and $0.095 are assumptions, not measured provider/hosting quotes. Sharing inventory across scopes can reduce this; customer rejection of review outputs can increase it substantially. At only 50% acceptance, the same $0.415 request cost plus reserve exceeds $0.90 per accepted output.

Budget $150/month for a small paid pilot's fixed hosting, database, storage baseline, monitoring, and email. This is a planning allowance, not a deployment quote. Avoid double-counting these baseline expenses with the variable reserve; track marginal storage and support separately. Founder wages, development, customer acquisition, tax, large disputes, and unusually heavy support are excluded from the contribution figures.

## Credit mechanics

- One credit buys one delivered photo × scope redesign, including planning, verification, and at most one automatic quality retry. Three scopes for a photo consume three credits. Two angles of one room are two photos and must be quoted accordingly.
- A customer-requested revision consumes one credit, including its normal retry. Cap reference inputs and pin counts so one revision cannot create unbounded API work; increase the quoted credit charge for an advanced workflow only after usage data establishes its cost.
- A taste build costs five credits per block of up to ten references: 10 references = 5; 20 = 10; 37 = 20. Quote the charge before starting. Reusing or manually editing a profile is free. Rebuilding it is a new paid operation.
- Save, view, compare, download, and share previously generated reports without generation charges. Export is local rendering in the current product and does not require another image call.
- Reserve credits when the job starts. Settle verified outputs; leave review outputs pending until the user accepts or rejects them, with an explicit timeout/release rule. Automatically release credits for failed/error/unchanged outputs and unstarted cancelled work. Never charge extra for automatic retries. Cancelled in-flight provider cost is absorbed; cap repetitive abuse.
- Treat credits as service usage units. Allow purchased packs to remain usable at launch, with disclosed storage retention limits. Model 100% redemption; do not rely on unused credits for profitability. Refund cash and reverse corresponding unused credits through a reconciled ledger when required.

Default two-model taste processing makes `3N + ceil(N/10) + 1` model calls: 10 references = 32 calls; 20 = 63; 37 = 116. Single-model analysis makes `N + ceil(N/10) + 1` calls. Token usage is unknown, so the five-credit price is a pilot hypothesis. At the base allowance it provides $3 of cost budget per block; meter the real blend of reference analysis, fusion, extraction, and profile synthesis before making large profiles available.

## Proposed prepaid packs

Prices are before tax. Fees assume domestic online cards at [Stripe's published 2.9% + $0.30](https://stripe.com/pricing). International cards, currency conversion, disputes, additional Stripe products, and refunds can change this.

| Pack | Price | Credits | Price/credit | Contribution at $0.60 cost | Margin | Margin at $0.90 cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Explore | $19 | 10 | $1.90 | $12.15 | 63.9% | 48.2% |
| Home | $49 | 30 | $1.63 | $29.28 | 59.8% | 41.4% |
| Compare | $99 | 65 | $1.52 | $56.83 | 57.4% | 37.7% |

`Contribution = price − (0.029 × price + 0.30) − credits × variable-cost allowance`

These are contribution margins before fixed expenses and acquisition, with every credit used. They are not net profit. The largest pack is the most sensitive to cost surprises; hold bulk discounts here until measured costs justify deeper ones. A 60% contribution target requires about $1.62 per credit at a $49 order and $0.60 cost, and about $2.43 at $0.90 cost. If the stress case becomes typical, raise prices, lower credit allocations, or reduce cost while preserving quality.

Examples:

- Explore: 10-reference taste profile (5), one photo in all three scopes (3), and two requested edits (2).
- Home: taste profile (5), ten photos in two scopes (20), and five requested edits (5).
- Ten photos in three scopes, a ten-reference profile, and five edits consume 40 credits, with a $24 base operating allowance. Home + Explore provides exactly 40 credits for $68; total payment fees are $2.57 and contribution is $41.43. Compare gives more room to explore, with 25 credits left after that workflow; its full-redemption margin already funds those credits.

At $150 monthly fixed cost, six fully redeemed $49 orders cover that allowance in the base case; eight cover it in stress. This is infrastructure break-even, not a viable salary-funded business.

| $49 orders/month | Revenue | Base contribution after $150 fixed | Stress contribution after $150 fixed |
| --- | ---: | ---: | ---: |
| 100 | $4,900 | $2,778 | $1,878 |
| 500 | $24,500 | $14,489 | $9,989 |
| 1,000 | $49,000 | $29,129 | $20,129 |

At $20 acquisition cost per new $49 buyer, 100 orders leave about $778 after that acquisition spend and the fixed allowance in base, and about negative $122 in stress. Retention and organic/referral distribution therefore matter as much as API margins. A $5,000 monthly founder-pay target plus $150 fixed would need about 176 $49 orders before acquisition; with $20 acquisition per order, about 556. These are illustrative targets, not demand forecasts.

## Market fit and launch recommendation

[REimagineHome's CRMLS partner page](https://www.reimaginehome.ai/partners/crmls) advertises $29/month for 200 credits, $49 for 500, and $99 for 1,200, plus member bonuses. This is a partner offer, not a verified universal offer or an identical output/quality comparison. It nevertheless signals strong price pressure for basic image restyling. Whim should validate whether its coherent taste, scope comparisons, structure checks, and cost reports command a higher price.

Start with home buyers and homeowners deciding whether a property can suit their taste and budget. Present prices as concrete outcomes—“10 photos, two renovation scopes, five refinements, and a taste profile”—alongside the credit count. Offer a small bounded trial (one generated photo using a preset taste), with real examples and reports accessible free. Avoid an unrestricted custom-profile trial: that is a many-call expense before purchase. At $0.60 per free design and 5% conversion, one free design per signup costs $12 per paying customer, before other acquisition spend; at 2%, it costs $30.

Defer unlimited plans. Test a professional monthly credit bundle only when repeat users appear, and charge separately for team/branding/service features. The consumer workflow is too episodic to assume durable monthly retention today.

## Work needed before collecting payment

1. **Meter first.** Persist provider, exact model, quality/resolution, input/cached/output/reasoning usage where available, request IDs, attempts, stage, cost-rate version, and job/customer ID. Count paid work that fails before writing a result. Reconcile with invoices. Record accepted/rejected review outputs and manual refund expense. Measure generation versus taste versus pin/reference revisions independently.
2. **Add customer ownership.** The current server uses private-host checks, shared filesystem data, global settings/keys, and in-memory jobs. Add authenticated accounts, account-owned resources and authorization, durable job state/queues, scoped sharing, and private object storage. Host validation alone is not customer isolation. Paid jobs must survive restarts.
3. **Add a transactional ledger.** Store purchases, reservations, settlements, releases, adjustments, and refunds in an append-only credit ledger. Atomically reserve available balance; prevent concurrent overspending. Grant credits only after verified server-side payment events, deduplicate events, and make job settlement/refunds idempotent. Never trust browser balance or checkout success redirects.
4. **Quote before running.** Show selected photos × scopes, profile blocks, edits, current balance, and resulting balance. Keep buyer-facing credit prices stable while tracking provider prices independently. Credits cannot become a direct multiplier of the present estimated API-spend UI.
5. **Run a bounded paid pilot.** A suggested gate is 20–30 paying users and at least 200 quoted outputs across different houses. Track accepted-output cost and latency, rejection/refunds, profile-build cost, pack conversion, repeat purchase, support time, and acquisition cost. Require sustainable contribution after trial/refund costs and evidence people pay for the full report before expanding traffic or discounts.

No billing code, deployment, provider-call experiments, or app restart was performed for this analysis. Existing README edits were preserved.
