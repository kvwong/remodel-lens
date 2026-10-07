// Reasoning effort for text models. A model id may end in :low, :medium or :high, e.g. openai/gpt-6.1-sol:low.

export const EFFORTS = ["low", "medium", "high"] as const;
export type Effort = (typeof EFFORTS)[number];

/** Reads the effort suffix off a model id. Medium when there is none. */
export function splitEffort(model: string): { model: string; effort: Effort } {
  const match = /^(.*):(low|medium|high)$/.exec(model);
  return match ? { model: match[1]!, effort: match[2] as Effort } : { model, effort: "medium" };
}

/** Appends the effort unless the model id already names one. */
export function withEffort(model: string, effort: Effort): string {
  return /:(low|medium|high)$/.test(model) ? model : `${model}:${effort}`;
}

/** Anthropic models that reject the effort parameter. */
export const NO_EFFORT = /^anthropic\/claude-haiku-4/;

export function supportsEffort(model: string): boolean {
  return !NO_EFFORT.test(splitEffort(model).model);
}

export function parseEffort(value: string | undefined): Effort | undefined {
  return (EFFORTS as readonly string[]).includes(value ?? "") ? (value as Effort) : undefined;
}
