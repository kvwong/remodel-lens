import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { generateMarkdown, generateStructured } from "../src/providers.js";
import { requireKeys } from "../src/config.js";
import { supportsEffort } from "../src/effort.js";
import { MODEL_OPTIONS } from "../src/app/settings-api.js";
import { Settings } from "../src/settings.js";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const model = "openrouter/qwen/qwen3.8-27b:low";
const response = (content: string) => new Response(JSON.stringify({
  id: "test", object: "chat.completion", created: 1, model: "qwen/qwen3.8-27b",
  choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
}), { headers: { "content-type": "application/json" } });

describe("OpenRouter analysis and reasoning", () => {
  it("routes vision analysis using the router key and omits unsupported effort parameters", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-router-key");
    const fetch = vi.fn().mockResolvedValue(response("  Room notes  "));
    vi.stubGlobal("fetch", fetch);
    expect(await generateMarkdown({ model, prompt: "Analyze this room", images: [{ bytes: new Uint8Array([1, 2]), mediaType: "image/png" }] })).toBe("Room notes");
    const [url, request] = fetch.mock.calls[0]!;
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(new Headers(request.headers).get("authorization")).toBe("Bearer test-router-key");
    const body = JSON.parse(request.body);
    expect(body.model).toBe("qwen/qwen3.8-27b");
    expect(body.messages[0].content[1]).toMatchObject({ type: "image_url" });
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("sends a JSON schema and validates structured planning output", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-router-key");
    const fetch = vi.fn().mockResolvedValue(response('{"room":"kitchen"}'));
    vi.stubGlobal("fetch", fetch);
    expect(await generateStructured({ model, prompt: "Inventory", schema: z.object({ room: z.string() }) })).toEqual({ room: "kitchen" });
    const body = JSON.parse(fetch.mock.calls[0]![1].body);
    expect(body.response_format.type).toBe("json_schema");
  });

  it("accepts every recommended model and requires OpenRouter for text-only selections too", () => {
    for (const option of MODEL_OPTIONS.reasoning.filter(o => o.id.startsWith("openrouter/"))) {
      expect(Settings.parse({ models: { reasoning: option.id, analysis: [option.id] } }).models.reasoning).toBe(option.id);
      expect(supportsEffort(option.id)).toBe(false);
    }
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    expect(() => requireKeys({ image: "gpt-image-2", analysis: [], reasoning: model })).toThrow("OPENROUTER_API_KEY");
  });
});
