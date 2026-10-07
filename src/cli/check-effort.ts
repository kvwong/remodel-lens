// Sends one small question to each Settings reasoning model at every effort level, to prove each level the slider
// offers is accepted. Costs a few cents. Usage: npm run check-effort [-- model ...]
import { loadEnv } from "../config.js";
import { EFFORTS, supportsEffort } from "../effort.js";
import { generateMarkdown } from "../providers.js";

loadEnv();

const MODELS = process.argv.slice(2).length > 0
  ? process.argv.slice(2)
  : ["openai/gpt-6.1-sol", "anthropic/claude-sonnet-5-5", "anthropic/claude-opus-5-5", "anthropic/claude-haiku-4-5"];
const PROMPT = "A room is 12 ft by 15 ft. Flooring costs $7.40 per square foot plus 10% waste. What is the total? Answer with the dollar amount only.";

// Records what each request actually sent and what came back, keyed by the effort it was made with.
const seen: { sent?: string; outputTokens?: number; reasoningTokens?: number }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const record: (typeof seen)[number] = {};
  seen.push(record);
  try {
    const body = JSON.parse(String(init?.body ?? "{}"));
    record.sent = body.reasoning?.effort ?? body.output_config?.effort ?? body.effort ?? "none";
  } catch {}
  const res = await realFetch(input, init);
  try {
    const usage = (await res.clone().json()).usage ?? {};
    record.outputTokens = usage.output_tokens;
    record.reasoningTokens = usage.output_tokens_details?.reasoning_tokens;
  } catch {}
  return res;
};

const rows: string[] = [];
for (const model of MODELS) {
  const levels = supportsEffort(model) ? EFFORTS : (["none"] as const);
  for (const level of levels) {
    const id = level === "none" ? model : `${model}:${level}`;
    const start = seen.length;
    const t0 = Date.now();
    try {
      const text = await generateMarkdown({ model: id, prompt: PROMPT, maxOutputTokens: 32000 });
      const r = seen.at(-1) ?? {};
      const tokens = r.reasoningTokens !== undefined ? `${r.outputTokens} out (${r.reasoningTokens} reasoning)` : `${r.outputTokens} out`;
      rows.push(`| ${model} | ${level} | ok | sent ${r.sent} | ${((Date.now() - t0) / 1000).toFixed(1)} s | ${tokens} | ${text.replace(/\s+/g, " ").slice(0, 30)} |`);
    } catch (error) {
      rows.push(`| ${model} | ${level} | FAILED | sent ${seen[start]?.sent ?? "?"} | | | ${(error as Error).message.replace(/\s+/g, " ").slice(0, 120)} |`);
    }
    process.stderr.write(`${rows.at(-1)}\n`);
  }
}
console.log(["| Model | Effort | Result | Request | Time | Tokens | Answer |", "|---|---|---|---|---|---|---|", ...rows].join("\n"));
