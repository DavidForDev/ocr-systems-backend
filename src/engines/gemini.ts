import { GoogleGenerativeAI } from "@google/generative-ai";
import { OCREngine, OCRResult } from "./base.js";

const PRICING: Record<string, { input: number; output: number }> = {
  "gemini-3.1-flash-lite": { input: 0.075, output: 0.3 },
};

class GeminiEngine extends OCREngine {
  id: string;
  name: string;
  provider = "Google";
  category = "Cloud LLM OCR";

  private _modelId: string;
  private _model: any;

  constructor(id: string, name: string, modelId: string) {
    super();
    this.id = id;
    this.name = name;
    this._modelId = modelId;
  }

  protected async _lazyInit() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY environment variable is required");

    const genai = new GoogleGenerativeAI(apiKey);
    this._model = genai.getGenerativeModel({ model: this._modelId });
  }

  protected async _recognize(imageBuffer: Buffer): Promise<OCRResult> {
    const start = performance.now();
    try {
      const prompt = this._prompt ||
        "Extract all text from this image exactly as it appears. Return only the raw extracted text, no formatting or explanation.";

      const imagePart = {
        inlineData: {
          data: imageBuffer.toString("base64"),
          mimeType: "image/png",
        },
      };

      const result = await this._model.generateContent([prompt, imagePart]);
      const response = result.response;
      const text = response.text() || "";

      const usage = response.usageMetadata;
      const inputTokens = usage?.promptTokenCount ?? 0;
      const outputTokens = usage?.candidatesTokenCount ?? 0;
      const totalTokens = usage?.totalTokenCount ?? 0;

      const pricing = PRICING[this._modelId] ?? { input: 0.15, output: 0.6 };
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

export const gemini31FlashLite = new GeminiEngine(
  "gemini-3.1-flash-lite",
  "Gemini 3.1 Flash-Lite",
  "gemini-3.1-flash-lite"
);
