import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, Output, type LanguageModel, type UserContent } from "ai";
import type { z } from "zod";

export type ImageInput = { bytes: Uint8Array; mediaType: string };

const providerOptions = {
  openai: { reasoningEffort: "medium" },
  anthropic: { effort: "medium" },
} as const;

function languageModel(model: string): LanguageModel {
  const [provider, ...rest] = model.split("/");
  const id = rest.join("/");
  if (provider === "openai") return createOpenAI({ apiKey: process.env.OPENAI_API_KEY })(id);
  if (provider === "anthropic") return createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })(id);
  throw new Error(`Unsupported model "${model}". Use an openai/… or anthropic/… id.`);
}

function content(prompt: string, images: ImageInput[]): UserContent {
  return [
    { type: "text", text: prompt },
    ...images.map((image) => ({
      type: "file" as const,
      data: image.bytes,
      mediaType: image.mediaType,
    })),
  ];
}

export async function generateMarkdown(input: {
  model: string;
  prompt: string;
  images?: ImageInput[];
  maxOutputTokens?: number;
}): Promise<string> {
  const result = await withRetries(() =>
    generateText({
      model: languageModel(input.model),
      messages: [{ role: "user", content: content(input.prompt, input.images ?? []) }],
      maxOutputTokens: input.maxOutputTokens ?? 8000,
      providerOptions,
      maxRetries: 2,
    }),
  );
  return result.text.trim();
}

export async function generateStructured<T>(input: {
  model: string;
  prompt: string;
  schema: z.ZodType<T>;
  images?: ImageInput[];
  maxOutputTokens?: number;
}): Promise<T> {
  const result = await withRetries(() =>
    generateText({
      model: languageModel(input.model),
      messages: [{ role: "user", content: content(input.prompt, input.images ?? []) }],
      output: Output.object({ schema: input.schema }),
      maxOutputTokens: input.maxOutputTokens ?? 16000,
      providerOptions,
      maxRetries: 2,
    }),
  );
  if (result.output === undefined) throw new Error(`${input.model} returned no structured output.`);
  return result.output;
}

export async function withRetries<T>(operation: () => Promise<T>, attempts = 5): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1 || !isRetryable(error)) break;
      const delay = Math.min(30_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 500);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

function isRetryable(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return false;
  const record = (error ?? {}) as Record<string, unknown>;
  const status = record.statusCode ?? record.status;
  if (typeof status !== "number") return true;
  return status === 408 || status === 409 || status === 429 || status >= 500;
}
