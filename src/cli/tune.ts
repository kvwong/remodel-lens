#!/usr/bin/env node
// Usage:
//   npm run tune                         Score every past run (no API calls) and write .runs/tuning/report.md
//   npm run tune -- labels               Add every scored image to .runs/tuning/labels.json for you to mark ok/broken
//   npm run tune -- compare <listing-dir> --models gpt-image-2,gpt-image-2.5-sunburst [--profile path] [--tiers ...] [--max n]
//                                        Redesign one listing once per image model (costs API spend), then score those runs
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
import { collectAttempts, readLabels, writeLabelTemplate } from "../tune/collect.js";

const TUNING_DIR = path.join(ROOT, ".runs", "tuning");
const LABELS = path.join(TUNING_DIR, "labels.json");

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
    const models = (values.models ?? "").split(",").map((m) => m.trim()).filter(Boolean);
    if (!listingArg || models.length < 2) throw new Error("Usage: npm run tune -- compare <listing-dir> --models model-a,model-b");
    const listingDir = path.resolve(listingArg);
    const tiers = parseTiers(values.tiers);
    const max = Number(values.max);
    const photos = Math.min(max, (await readListing(listingDir)).photos.filter((p) => p.selected).length);
    const cost = estimateRunCost(photos, tiers.length);
    log(`${models.length} runs × ${photos} photos × ${tiers.length} tiers: about $${(cost.low * models.length).toFixed(2)}–$${(cost.high * models.length).toFixed(2)}`);
    const runs = new Set<string>();
    for (const imageModel of models) {
      log(`Image model ${imageModel}`);
      const run = await runListingRedesign({ listingDir, profilePath: path.resolve(values.profile), tiers, max, imageModel });
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
