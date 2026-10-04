import type { Models } from "../config.js";
import { CancelledError, isCancelled, log, mapLimit, progressAdd, progressDone, writeArtifact, writeJson, type LocalImage } from "../files.js";
import { generateMarkdown, generateStructured } from "../providers.js";
import { analysisPrompt, chunkPrompt, fusionPrompt, profilePrompt } from "./prompts.js";
import { TasteProfile, type TasteRule } from "./schema.js";

export async function buildTasteProfile(input: {
  images: LocalImage[];
  models: Models;
  outDir: string;
  chunkSize?: number;
  /** Owner-written taste brief, used as a strong prior alongside the images. */
  brief?: string | undefined;
}): Promise<TasteProfile> {
  const { images, models, outDir, brief } = input;
  if (brief) await writeArtifact(outDir, "brief.md", brief);
  const perImage = models.analysis.length * 2 + (models.analysis.length > 1 ? 1 : 0);
  const chunkCount = Math.ceil(images.length / (input.chunkSize ?? 10));
  progressAdd(images.length * perImage + chunkCount * 2 + 2);

  // 1. Independent analyses + blind fusion, per image.
  const notes = await mapLimit(
    images,
    4,
    async (image) => {
      if (isCancelled()) throw new CancelledError();
      log(`Analyzing ${image.id} (${image.basename})`);
      const analyses = await Promise.all(
        models.analysis.map(async (model) => {
          const text = await generateMarkdown({ model, prompt: analysisPrompt(image), images: [image] });
          await writeArtifact(outDir, `01-analyses/${image.id}/${model.replace("/", "_")}.md`, text);
          progressDone(2, `${image.basename}: analyzed`);
          return text;
        }),
      );
      const fused =
        analyses.length === 1
          ? analyses[0]!
          : await generateMarkdown({
              model: models.reasoning,
              prompt: fusionPrompt(image, analyses),
              images: [image],
            });
      await writeArtifact(outDir, `02-notes/${image.id}.md`, fused);
      if (analyses.length > 1) progressDone(1, `${image.basename}: notes merged`);
      return { id: image.id, text: fused };
    },
  );

  // 2. Chunked rule extraction keeps each call's context small and forces cross-image patterns.
  const chunkSize = input.chunkSize ?? 10;
  const chunks: Array<{ id: string; text: string }> = [];
  for (let start = 0; start < notes.length; start += chunkSize) {
    if (isCancelled()) throw new CancelledError();
    const id = `chunk_${String(chunks.length + 1).padStart(2, "0")}`;
    log(`Extracting rules for ${id}`);
    const text = await generateMarkdown({
      model: models.reasoning,
      prompt: chunkPrompt(id, notes.slice(start, start + chunkSize), brief),
      maxOutputTokens: 16000,
    });
    await writeArtifact(outDir, `03-rules/${id}.md`, text);
    progressDone(2, `${id}: rules extracted`);
    chunks.push({ id, text });
  }

  // 3. Structured profile.
  if (isCancelled()) throw new CancelledError();
  log("Writing taste profile");
  const profile = await generateStructured({
    model: models.reasoning,
    prompt: profilePrompt(chunks, images.length, brief),
    schema: TasteProfile,
  });
  const result: TasteProfile = { ...profile, imageCount: images.length };
  for (const category of result.categories) {
    for (const rule of category.rules) rule.support = Math.min(rule.support, images.length);
  }
  await writeJson(outDir, "taste-profile.json", result);
  progressDone(2, "Profile written");
  await writeArtifact(outDir, "taste-profile.md", renderProfileMarkdown(result));
  return result;
}

/**
 * Strong = stated in the owner's brief, or seen in at least ~a quarter of the references (min 2).
 * Everything else is a single-photo signal that shouldn't steer a redesign on its own.
 */
export function isStrongRule(rule: TasteRule, imageCount: number): boolean {
  return rule.fromBrief || rule.support >= Math.max(2, Math.ceil(imageCount * 0.25));
}

export function renderProfileMarkdown(profile: TasteProfile): string {
  const total = profile.imageCount ?? 0;
  const lines = [
    "# Taste profile",
    "",
    profile.summary,
    "",
    `**Era:** ${profile.era}`,
    "",
    "## Palette",
    `- Walls: ${profile.palette.walls.join(", ")}`,
    `- Wood: ${profile.palette.woodTones.join(", ")}`,
    `- Metals: ${profile.palette.metals.join(", ")}`,
    `- Accents: ${profile.palette.accents.join(", ")}`,
    `- Contrast: ${profile.palette.contrast}, saturation: ${profile.palette.saturation}`,
  ];
  for (const category of profile.categories) {
    lines.push("", `## ${category.category.replace(/_/g, " ")}`);
    for (const rule of category.rules) {
      const weak = total && !isStrongRule(rule, total) ? " _(weak signal)_" : "";
      const brief = rule.fromBrief ? ", brief" : "";
      lines.push(`- ${rule.rule} — ${rule.support}/${total} images${brief}${weak}`);
    }
    for (const avoid of category.avoid) lines.push(`- Avoid: ${avoid}`);
  }
  if (profile.expressions.length) {
    lines.push("", "## Expressions (one per room)", ...profile.expressions.map((e) => `- **${e.name}:** ${e.description}`));
  }
  lines.push("", "## Avoid everywhere", ...profile.globalAvoid.map((a) => `- ${a}`));
  for (const room of profile.roomNotes) {
    lines.push("", `## ${room.room}`, ...room.notes.map((n) => `- ${n}`));
  }
  lines.push("", "## Image prompt summary", "", profile.imagePromptSummary, "");
  return lines.join("\n");
}
