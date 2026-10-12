// OpenAI's Decisions API (beta): typed answers about text and images, about 10x faster than a chat call,
// $0.10 per million input tokens and no output charge. It answers fixed questions only; no free text.
import type { ImageInput } from "./providers.js";

export const DECISIONS_MODEL = "gpt-6-luna";

export type DecisionQuestion =
  | { type: "predicate"; name: string; instructions: string }
  | { type: "choice"; name: string; instructions: string; choices: Array<{ value: string; description: string }> }
  | { type: "score"; name: string; instructions: string; levels: Array<{ label: string; description: string }> };

export type DecisionAnswer =
  | { type: "predicate"; name: string; probability: number }
  | { type: "choice"; name: string; choice: string; confidence?: number }
  | { type: "score"; name: string; score: number; confidence?: number }
  | { type: "refusal"; name: string };

type Fetch = typeof fetch;

/** Asks the questions about the text and images; throws on any API error so callers can fall back to a full model. */
export async function decide(input: { text: string; images: ImageInput[]; questions: DecisionQuestion[] }, fetchFn: Fetch = fetch): Promise<Map<string, DecisionAnswer>> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("Missing OPENAI_API_KEY.");
  const res = await fetchFn("https://api.openai.com/v1/decisions", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({
      model: DECISIONS_MODEL,
      input: [{ role: "user", content: [
        { type: "input_text", text: input.text },
        ...input.images.map((image) => ({ type: "input_image", image_url: `data:${image.mediaType};base64,${Buffer.from(image.bytes).toString("base64")}` })),
      ] }],
      questions: input.questions,
    }),
  });
  if (!res.ok) throw new Error(`Decisions API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { answers?: DecisionAnswer[] };
  return new Map((body.answers ?? []).map((answer) => [answer.name, answer]));
}
