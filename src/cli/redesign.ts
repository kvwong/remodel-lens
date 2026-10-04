#!/usr/bin/env node
// Usage: npm run redesign -- <listing-dir> [--profile path] [--tiers cosmetic,moderate,major] [--out dir] [--max 24]
// Uses the photo selection and room labels saved in <listing-dir>/listing.json (edit them with `npm run app`).
import path from "node:path";
import { parseArgs } from "node:util";

import { loadEnv } from "../config.js";
import { log } from "../files.js";
import { runListingRedesign } from "../redesign/job.js";
import { parseTiers } from "../redesign/tiers.js";

async function main() {
  loadEnv();
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      profile: { type: "string", default: "profiles/example/profile.json" },
      tiers: { type: "string" },
      out: { type: "string" },
      max: { type: "string", default: "24" },
    },
  });
  if (!positionals[0]) {
    throw new Error("Usage: npm run redesign -- <listing-dir> [--profile taste-profile.json] [--tiers cosmetic,moderate,major]");
  }

  const run = await runListingRedesign({
    listingDir: path.resolve(positionals[0]),
    profilePath: path.resolve(values.profile),
    tiers: parseTiers(values.tiers),
    outDir: values.out ? path.resolve(values.out) : undefined,
    max: Number(values.max),
  });
  process.stdout.write(`${path.join(run.outDir, "report.html")}\n`);
}

main().catch((error) => {
  log(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
