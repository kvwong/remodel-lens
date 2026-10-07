#!/usr/bin/env node
// Usage:
//   npm run tune                         Score every past run (no API calls) and write .runs/tuning/report.md
//   npm run tune -- labels               Add every scored image to .runs/tuning/labels.json for you to mark ok/broken
//   npm run tune -- compare <listing-dir> --models gpt-image-2,gpt-image-2.5-sunburst [--profile path] [--tiers ...] [--max n]
//                                        Redesign one listing once per image model (costs API spend), then score those runs
//   npm run tune -- compare <listing-dir> --planners openai/gpt-6.1-sol,openai/gpt-6.1-sol:low [...]
//                                        Same, once per inventory/planning model (judge and image model stay fixed); compare run times in the report
import path from "node:path";
import { parseArgs } from "node:util";

import { loadEnv, ROOT } from "../config.js";
import { estimateRunCost } from "../costs.js";
import { log, writeArtifact } from "../files.js";
import { readListing } from "../listing/listing.js";
import { RUNS_DIR, runListingRedesign } from "../redesign/job.js";
import { parseTiers } from "../redesign/tiers.js";
import { edgeThreshold } from "../redesign/verify.js";
import { renderTuningReport } from "../tune/analyze.js";
import { collectAttempts, LABELS_FILE as LABELS, readLabels, TUNING_DIR, writeLabelTemplate } from "../tune/collect.js";

async function report(only?: Set<string>) {
  const records = await collectAttempts(RUNS_DIR, { labels: await readLabels(LABELS), ...(only ? { only } : {}) });
  const markdown = renderTuningReport(records, edgeThreshold());
  const file = await writeArtifact(TUNING_DIR, "report.md", markdown);
  process.stdout.write(`${markdown}\n`);
  log(`Wrote ${path.relative(ROOT, file)}`);
}

async function main() {
  loadEnv();
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      models: { type: "string" },
      planners: { type: "string" },
      profile: { type: "string", default: "profiles/example/profile.json" },
      tiers: { type: "string" },
      max: { type: "string", default: "24" },
    },
  });
  const [command = "report", listingArg] = positionals;

  if (command === "report") return report();

  if (command === "labels") {
    const records = await collectAttempts(RUNS_DIR);
    const { added, total } = await writeLabelTemplate(LABELS, records);
    log(`Added ${added} images to ${path.relative(ROOT, LABELS)} (${total} total). Set each "label" to "ok" or "broken", then run npm run tune.`);
    return;
  }

  if (command === "compare") {
    const list = (value: string | undefined) => (value ?? "").split(",").map((m) => m.trim()).filter(Boolean);
    const planners = list(values.planners);
    const models = list(values.models);
    const variants = planners.length > 0 ? planners : models;
    if (!listingArg || variants.length < 2 || (planners.length > 0 && models.length > 0)) {
      throw new Error("Usage: npm run tune -- compare <listing-dir> --models image-a,image-b  (or --planners model-a,model-b)");
    }
    const listingDir = path.resolve(listingArg);
    const tiers = parseTiers(values.tiers);
    const max = Number(values.max);
    const photos = Math.min(max, (await readListing(listingDir)).photos.filter((p) => p.selected).length);
    const cost = estimateRunCost(photos, tiers.length);
    log(`${variants.length} runs × ${photos} photos × ${tiers.length} tiers: about $${(cost.low * variants.length).toFixed(2)}–$${(cost.high * variants.length).toFixed(2)}`);
    const runs = new Set<string>();
    for (const variant of variants) {
      log(planners.length > 0 ? `Planner ${variant}` : `Image model ${variant}`);
      const run = await runListingRedesign({
        listingDir,
        profilePath: path.resolve(values.profile),
        tiers,
        max,
        ...(planners.length > 0 ? { plannerModel: variant } : { imageModel: variant }),
      });
      runs.add(`${run.listing}/${run.id}`);
    }
    return report(runs);
  }

  throw new Error(`Unknown command "${command}". Use report, labels, or compare.`);
}

main().catch((error) => {
  log(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
