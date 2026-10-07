#!/usr/bin/env node
// Usage: npm run change -- <run-dir> <photo-id> <scope> ["change for the whole room"]
//          [--pin "x,y=note"]... [--notes "context"] [--from v2] [--ref photo.jpg]...
// Adds a version of one photo at one scope to a saved run. Pins are 0–1000 from the image's top-left.
// The run's report shows it the next time it's opened in the app.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { loadEnv, requireKeys, resolveModels } from "../config.js";
import { log } from "../files.js";
import { startChange } from "../redesign/change.js";
import { parseTiers } from "../redesign/tiers.js";
import { ORIGINAL, pickKey, readVersions, type Pin } from "../redesign/versions.js";

function parsePin(value: string): Pin {
  const match = /^\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*=\s*(.+)$/.exec(value);
  if (!match) throw new Error(`Pins look like "420,310=smaller brass pendant", not "${value}".`);
  return { x: Number(match[1]), y: Number(match[2]), note: match[3]!.trim() };
}

async function main() {
  loadEnv();
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      pin: { type: "string", multiple: true, default: [] },
      notes: { type: "string", default: "" },
      from: { type: "string" },
      ref: { type: "string", multiple: true, default: [] },
    },
  });
  const [dir, photoId, scope, ask = ""] = positionals;
  if (!dir || !photoId || !scope) {
    throw new Error('Usage: npm run change -- <run-dir> <photo-id> <cosmetic|moderate|major> ["change"] [--pin "x,y=note"] [--notes "..."] [--from v2] [--ref photo.jpg]');
  }
  const runDir = path.resolve(dir);
  const [tier] = parseTiers(scope);
  const models = resolveModels();
  requireKeys({ ...models, analysis: [] }); // a change only plans, edits, and judges
  // Default to the version the report currently uses, the one you'd be looking at.
  const from = values.from ?? (await readVersions(runDir)).picks[pickKey(photoId, tier!)] ?? ORIGINAL;
  const { id, work } = await startChange({
    runDir,
    photoId,
    tier: tier!,
    from,
    request: { ask, notes: values.notes, pins: values.pin.map(parsePin) },
    references: await Promise.all(values.ref.map((file) => readFile(path.resolve(file)))),
    models,
  });
  log(`${photoId} ${tier}: making ${id} from ${from}`);
  const version = await work();
  log(`${id}: ${version.status}${version.reasons.length ? ` — ${version.reasons.join(" ")}` : ""}`);
  if (version.image) process.stdout.write(`${path.join(runDir, version.image)}\n`);
}

main().catch((error) => {
  log(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
