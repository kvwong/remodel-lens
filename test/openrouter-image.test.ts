import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { editImage, supportsMask } from "../src/redesign/generate.js";
import { requireKeys } from "../src/config.js";
import { Settings } from "../src/settings.js";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const model = "openrouter/black-forest-labs/flux.2-klein-4b";
const endpoint = { provider_tag: "black-forest-labs", supported_parameters: {
  input_references: { max: 4 }, aspect_ratio: { values: ["1:1", "4:3", "3:4"] },
  output_format: { values: ["png", "jpeg"] }, n: { max: 1 },
} };
const original = () => sharp({ create: { width: 40, height: 30, channels: 3, background: "#aaa" } }).png().toBuffer();

describe("OpenRouter image editing", () => {
  it("routes source and revision references to OpenRouter and normalizes returned JPEG to PNG", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-only-router-key");
    vi.stubEnv("OPENAI_API_KEY", "");
    const input = await original();
    const jpeg = await sharp(input).jpeg().toBuffer();
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ endpoints: [endpoint] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ b64_json: jpeg.toString("base64"), media_type: "image/jpeg" }] })));
    vi.stubGlobal("fetch", fetch);
    const result = await editImage({ model, image: input, references: [input], mask: null, prompt: "Keep the windows; change the paint." });
    expect((await sharp(result).metadata()).format).toBe("png");
    const [url, request] = fetch.mock.calls[1]!;
    expect(url).toBe("https://openrouter.ai/api/v1/images");
    expect(request.headers.authorization).toBe("Bearer test-only-router-key");
    const body = JSON.parse(request.body);
    expect(body).toMatchObject({ model: "black-forest-labs/flux.2-klein-4b", aspect_ratio: "4:3", n: 1,
      provider: { only: ["black-forest-labs"], allow_fallbacks: false } });
    expect(body.input_references).toHaveLength(2);
    expect(body.input_references[0].image_url.url).toBe(`data:image/png;base64,${input.toString("base64")}`);
    expect(body).not.toHaveProperty("mask");
    expect(body).not.toHaveProperty("resolution"); // FLUX endpoint does not expose this knob.
  });

  it("refuses excess references before any generation request", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-only");
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ endpoints: [endpoint] })));
    vi.stubGlobal("fetch", fetch);
    const input = await original();
    await expect(editImage({ model, image: input, references: [input, input, input, input], mask: null, prompt: "edit" })).rejects.toThrow("accepting 5 input images");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reports credit errors without retrying permanent failures or exposing provider responses", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-only");
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ endpoints: [endpoint] })))
      .mockResolvedValueOnce(new Response("private provider details", { status: 402 }));
    vi.stubGlobal("fetch", fetch);
    await expect(editImage({ model, image: await original(), mask: null, prompt: "edit" })).rejects.toThrow("check your credit balance");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("validates provider keys and saved routing IDs without requiring an unused OpenAI key", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-only");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "test-only");
    expect(() => requireKeys({ image: model, analysis: [], reasoning: "anthropic/claude-sonnet-5-5" })).not.toThrow();
    expect(() => requireKeys({ image: model, analysis: [], reasoning: "openai/gpt-6.1-sol" })).toThrow("OPENAI_API_KEY");
    expect(Settings.parse({ models: { image: model } }).models.image).toBe(model);
    expect(() => Settings.parse({ models: { image: "openrouter/../bad" } })).toThrow();
    expect(supportsMask(model)).toBe(false);
    expect(supportsMask("gpt-image-2")).toBe(true);
  });
});
