import sharp from "sharp";
import { withRetries } from "../providers.js";

type Capability = { values?: string[]; min?: number; max?: number };
type Endpoint = { provider_tag?: string; supported_parameters: Record<string, Capability> };
const BASE = "https://openrouter.ai/api/v1";

/** Dedicated image API: reference 1 is the scene being edited, not a new text-to-image render. */
export async function editOpenRouterImage(input: {
  model: string; image: Buffer; prompt: string; references?: Buffer[];
}): Promise<Buffer> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("Missing OPENROUTER_API_KEY. Add it on the Settings page.");
  const model = input.model.slice("openrouter/".length);
  if (!/^\w[\w.:-]*\/\w[\w.:-]*$/.test(model)) throw new Error("Use an OpenRouter image model ID such as black-forest-labs/flux.2-klein-4b.");
  const references = [input.image, ...(input.references ?? [])];
  const discovery = await withRetries(() => fetch(`${BASE}/images/models/${model}/endpoints`, { signal: AbortSignal.timeout(20_000) }).then(checkResponse));
  const catalog = await discovery.json() as { endpoints?: Endpoint[]; data?: { endpoints?: Endpoint[] } };
  const endpoint = (catalog.endpoints ?? catalog.data?.endpoints ?? []).find(e =>
    (e.supported_parameters.input_references?.max ?? 0) >= references.length);
  if (!endpoint) throw new Error(`${model} has no image-editing endpoint accepting ${references.length} input images. Use fewer references or choose another image model.`);
  const capabilities = endpoint.supported_parameters;
  const { width = 1, height = 1 } = await sharp(input.image).metadata();
  const ratios = capabilities.aspect_ratio?.values?.filter(v => /^\d+:\d+$/.test(v)) ?? [];
  const aspectRatio = ratios.sort((a, b) => {
    const distance = (v: string) => { const [w, h] = v.split(":").map(Number); return Math.abs(Math.log(w! / h! / (width / height))); };
    return distance(a) - distance(b);
  })[0];
  const resolutions = capabilities.resolution?.values ?? [];
  const resolution = resolutions.includes("1K") ? "1K" : resolutions[0];
  const response = await withRetries(() => fetch(`${BASE}/images`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "X-OpenRouter-Title": "Whim" },
    body: JSON.stringify({ model, prompt: input.prompt,
      input_references: references.map(bytes => ({ type: "image_url", image_url: { url: `data:image/png;base64,${bytes.toString("base64")}` } })),
      ...(capabilities.n ? { n: 1 } : {}),
      ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
      ...(resolution ? { resolution } : {}),
      ...(capabilities.output_format?.values?.includes("png") ? { output_format: "png" } : {}),
      ...(endpoint.provider_tag ? { provider: { only: [endpoint.provider_tag], allow_fallbacks: false } } : {}),
    }),
    signal: AbortSignal.timeout(300_000),
  }).then(checkResponse));
  const result = await response.json() as { data?: { b64_json?: string; media_type?: string }[] };
  const image = result.data?.[0];
  if (!image?.b64_json) throw new Error(`${model} returned no image.`);
  if (image.media_type && !["image/png", "image/jpeg", "image/webp"].includes(image.media_type)) throw new Error(`${model} returned an unsupported image format.`);
  // Every report and verification artifact is a genuine PNG, even for JPEG/WebP providers.
  return sharp(Buffer.from(image.b64_json, "base64")).png().toBuffer();
}

function checkResponse(response: Response): Response {
  if (!response.ok) throw Object.assign(new Error(`OpenRouter image API returned ${response.status}${response.status === 402 ? ": check your credit balance or key spending limit" : ""}.`), { status: response.status });
  return response;
}
