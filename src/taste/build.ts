import path from "node:path";

import { requireKeys, resolveModels, ROOT } from "../config.js";
import { loadImages, log, runId } from "../files.js";
import { buildTasteProfile } from "./pipeline.js";
import { inputSignature, MAX_REFERENCES, profileDir, readBrief, readTasteProfile, saveProfileJson } from "./store.js";

/** Rebuild a profile's rules from its current references and brief. The previous rules are kept as a backup. */
export async function runTasteBuild(id: string): Promise<{ outDir: string; ruleCount: number }> {
  const models = resolveModels();
  requireKeys(models);
  const stored = await readTasteProfile(id);
  if (!stored) throw Object.assign(new Error("Profile not found"), { status: 404 });
  const signature = await inputSignature(id); // what this build actually consumed
  const images = await loadImages(path.join(profileDir(id), "references"), MAX_REFERENCES, "ref");
  if (images.length < 3) throw Object.assign(new Error("Add at least 3 reference photos before building."), { status: 400 });
  const brief = (await readBrief(id)).trim() || undefined;

  const outDir = path.join(ROOT, ".runs", "taste", `${id}-${runId()}`);
  log(`${stored.meta.name}: ${images.length} references${brief ? " + brief" : ""} → ${path.relative(ROOT, outDir)}`);
  const profile = await buildTasteProfile({ images, models, outDir, brief });
  await saveProfileJson(id, profile, "pipeline", signature);
  const ruleCount = profile.categories.reduce((n, c) => n + c.rules.length, 0);
  log(`Done: ${ruleCount} rules from ${images.length} references`);
  return { outDir, ruleCount };
}
