#!/usr/bin/env node
// Usage: npm run taste -- [--profile <id>]
// Rebuilds a taste profile's rules from profiles/<id>/references and profiles/<id>/brief.md.
// Create and edit profiles in the app (npm run app → Taste profiles).
import path from "node:path";
import { parseArgs } from "node:util";

import { loadEnv, ROOT } from "../config.js";
import { log } from "../files.js";
import { runTasteBuild } from "../taste/build.js";

async function main() {
  loadEnv();
  const { values } = parseArgs({ options: { profile: { type: "string", default: "example" } } });
  const result = await runTasteBuild(values.profile);
  process.stdout.write(`${path.join(ROOT, "profiles", values.profile, "profile.md")}\n`);
  log(`Run artifacts in ${path.relative(process.cwd(), result.outDir)}`);
}

main().catch((error) => {
  log(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
