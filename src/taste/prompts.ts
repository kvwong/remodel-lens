import { TASTE_CATEGORIES } from "./schema.js";

const SCOPE = `This is about interior design taste: what is in the room and how it is finished. The physical objects ARE the signal: furniture silhouettes, materials, finishes, fixtures, millwork profiles, hardware, flooring, lighting, textiles, and how densely the room is filled.

Treat as incidental (do not turn into taste rules): the photographer's styling props, lens/lighting of the photo itself, season, views out the window, the architecture's fixed geometry (ceiling height, window count, room size), and anything you cannot actually see. Many references are screenshots from social media: ignore carousel arrows, pagination dots, avatar icons, captions, mute buttons, watermarks, and people.`;

function briefSection(brief: string | undefined): string {
  if (!brief) return "";
  return `
The owner also wrote this brief describing their taste. Treat it as a high-priority prior: use the images to confirm it, make it more specific, and catch things it misses. Where an image contradicts the brief, follow the brief and note the conflict. Brief rules with no image evidence can be kept with support 0.

<owner-brief>
${brief.trim()}
</owner-brief>
`;
}

const SPECIFICITY = `Be specific enough that a contractor or image model could act on it. "Warm wood" is too vague; "rift-sawn white oak, matte natural finish, no orange cast" is useful. Name materials, finishes (matte/satin/gloss, honed/polished), profiles (slab, shaker, beaded inset), metals and their sheen, color temperature of light, and proportions. If you are unsure of a material, give your best identification and say so.`;

export function analysisPrompt(image: { id: string; basename: string }): string {
  return `You are analyzing one interior design reference photo. The owner chose it because it represents the interiors they want. Extract the taste, not a description of this specific house.

${SCOPE}

${SPECIFICITY}

# ${image.id} — ${image.basename}

Write these sections:

## 1. What is in the frame
Room type and the main surfaces and objects, briefly.

## 2. Palette
Wall, ceiling, trim colors; wood tones; metals; accent colors; overall contrast and saturation.

## 3. Materials and finishes
Per surface: flooring, counters, cabinetry, tile, walls, ceiling. Material, finish, color, pattern, scale.

## 4. Cabinetry, millwork, and trim
Door style, profile, hardware, trim width and profile, built-ins.

## 5. Lighting
Fixture types and silhouettes, metals, how many sources, warm vs cool, decorative vs recessed.

## 6. Furniture and soft goods
Silhouettes (curved/rectilinear, leggy/grounded), scale, upholstery materials, rugs, window treatments.

## 7. Density and composition
How full or sparse, how much is on surfaces, symmetry, negative space.

## 8. Era and character
Period references and how literal or loose they are.

## 9. Transferable rules
8–15 imperative rules that would make a different room feel like this one.

## 10. What to ignore
Things in this photo that should NOT become rules.`;
}

export function fusionPrompt(image: { id: string; basename: string }, analyses: string[]): string {
  const sections = analyses
    .map((text, index) => `Analysis ${index + 1}:\n---\n${text}\n---`)
    .join("\n\n");
  return `You are merging independent analyses of the same interior reference photo into one definitive note. The analyses are anonymized peers; do not favor one because it resembles your wording. Look at the photo again and resolve disagreements from what is visible. Correct misidentified materials. Drop anything not actually visible.

${SCOPE}

${SPECIFICITY}

${sections}

Write the merged note with the same sections as the analyses (What is in the frame; Palette; Materials and finishes; Cabinetry, millwork, and trim; Lighting; Furniture and soft goods; Density and composition; Era and character; Transferable rules; What to ignore). Title it "# ${image.id} — ${image.basename}".`;
}

export function chunkPrompt(chunkId: string, notes: Array<{ id: string; text: string }>, brief?: string): string {
  const bundle = notes.map((note) => `<image-note id="${note.id}">\n${note.text}\n</image-note>`).join("\n\n");
  return `You are extracting a strict interior design rule set from ${notes.length} reference-photo notes. The owner wants a consistent taste they can apply to other houses, so patterns that repeat across photos matter most.

${SPECIFICITY}

Rules must be:
- observable in the notes,
- imperative ("Use…", "Keep…", "Avoid…"),
- concrete about material, finish, color, profile, metal, fixture type, silhouette, or density,
- transferable to a room with different architecture.

For every rule, list the image ids that support it in brackets, e.g. [img_02, img_05]. A rule seen in one photo is allowed but must show only that one id. If photos conflict, say so instead of averaging them.
${briefSection(brief)}
${bundle}

# ${chunkId} rules

Group rules under these headings: ${TASTE_CATEGORIES.join(", ")}.
Then add "## Avoid" (concrete things this taste rejects) and "## Room-specific notes" (kitchen, bath, bedroom, living, etc., only where the notes support it).`;
}

export function profilePrompt(chunks: Array<{ id: string; text: string }>, imageCount: number, brief?: string): string {
  const bundle = chunks.map((chunk) => `<chunk id="${chunk.id}">\n${chunk.text}\n</chunk>`).join("\n\n");
  return `Merge these chunk rule sets (from ${imageCount} interior reference photos total) into one structured taste profile.

${SPECIFICITY}

- Deduplicate. When chunks agree, combine them and add up support (count distinct image ids).
- "support" is the number of distinct reference images backing the rule. Never exceed ${imageCount}.
- "fromBrief" is true only if the owner's brief states the rule${brief ? "" : " (there is no brief, so always false)"}.
- Keep low-support rules but do not let them contradict high-support ones.
- Use every category that has evidence; omit categories with none.
- expressions: if the brief or images show distinct directions within the taste (e.g. an earthy one and a playful one), name each and describe its materials and accents concretely. Leave empty if there is only one direction.
- globalAvoid: concrete rejections (materials, finishes, silhouettes, colors), not mood words.
- imagePromptSummary will be pasted into an image-editing prompt. Make it dense, visual, and free of vague praise. Include lighting color temperature if known.
- roomNotes: one entry per room type with evidence, named exactly "kitchen", "living room", "home office", "bathroom", "bedroom", "dining room", or "gym". Make these detailed; they are pasted into prompts for that room type.
${briefSection(brief)}
${bundle}`;
}
