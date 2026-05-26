import { Mistral } from "@mistralai/mistralai";
import { OCREngine, OCRResult } from "./base.js";

const PRICING: Record<string, { input: number; output: number }> = {
  "pixtral-large-latest": { input: 2.0, output: 6.0 },
  "pixtral-12b-2409": { input: 0.15, output: 0.15 },
};

class MistralVisionEngine extends OCREngine {
  id: string;
  name: string;
  provider = "Mistral";
  category = "Cloud LLM OCR";

  private _modelId: string;
  private _client!: Mistral;

  constructor(id: string, name: string, modelId: string) {
    super();
    this.id = id;
    this.name = name;
    this._modelId = modelId;
  }

  protected async _lazyInit() {
    const apiKey = process.env.MISTRAL_API_KEY;
    if (!apiKey) throw new Error("MISTRAL_API_KEY environment variable is required");
    this._client = new Mistral({ apiKey });
  }

  protected async _recognize(imageBuffer: Buffer): Promise<OCRResult> {
    const start = performance.now();
    try {
      const prompt = this._prompt ||
        "Extract all text from this image exactly as it appears. Return only the raw extracted text, no formatting or explanation.";

      const base64 = imageBuffer.toString("base64");

      const result = await this._client.chat.complete({
        model: this._modelId,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              {
                type: "image_url",
                imageUrl: `data:image/png;base64,${base64}`,
              },
            ],
          },
        ],
      });

      const choice = result.choices?.[0];
      const text = (choice?.message?.content as string) ?? "";

      const usage = result.usage ?? {};
      const inputTokens = (usage as any).promptTokens ?? 0;
      const outputTokens = (usage as any).completionTokens ?? 0;
      const totalTokens = (usage as any).totalTokens ?? 0;

      const pricing = PRICING[this._modelId] ?? { input: 0.15, output: 0.15 };
      const cost = (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;

      return {
        text: text.trim(),
        confidence: null,
        processing_time: +((performance.now() - start) / 1000).toFixed(3),
        engine_id: this.id,
        engine_name: this.name,
        error: null,
        metadata: {
          model: this._modelId,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          total_tokens: totalTokens,
          cost_usd: +cost.toFixed(6),
          pricing_per_1m_input: pricing.input,
          pricing_per_1m_output: pricing.output,
          pricing_model: "per_token",
        },
      };
    } catch (e: any) {
      return {
        text: "",
        confidence: null,
        processing_time: +((performance.now() - start) / 1000).toFixed(3),
        engine_id: this.id,
        engine_name: this.name,
        error: e.message,
        metadata: {},
      };
    }
  }
}

export const pixtralLarge = new MistralVisionEngine(
  "pixtral-large",
  "Pixtral Large",
  "pixtral-large-latest"
);

export const pixtral12b = new MistralVisionEngine(
  "pixtral-12b",
  "Pixtral 12B",
  "pixtral-12b-2409"
);
