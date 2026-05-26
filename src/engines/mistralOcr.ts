import { Mistral } from "@mistralai/mistralai";
import { OCREngine, OCRResult } from "./base.js";

const PRICING = { input: 1.0, output: 1.0 };

class MistralOcrEngine extends OCREngine {
  id = "mistral-ocr";
  name = "Mistral OCR";
  provider = "Mistral";
  category = "Cloud OCR";

  private _client!: Mistral;

  protected async _lazyInit() {
    const apiKey = process.env.MISTRAL_API_KEY;
    if (!apiKey) throw new Error("MISTRAL_API_KEY environment variable is required");
    this._client = new Mistral({ apiKey });
  }

  protected async _recognize(imageBuffer: Buffer): Promise<OCRResult> {
    const start = performance.now();
    try {
      const base64 = imageBuffer.toString("base64");
      const dataUrl = `data:image/png;base64,${base64}`;

      const result = await this._client.ocr.process({
        model: "mistral-ocr-latest",
        document: { type: "image_url", imageUrl: dataUrl },
      });

      const pages = result.pages ?? [];
      const text = pages.map((p: any) => p.markdown ?? "").join("\n\n");

      const usage = (result as any).usageInfo ?? {};
      const inputTokens = usage.pagesProcessed ?? pages.length;
      const cost = inputTokens * PRICING.input / 1000;

      return {
        text: text.trim(),
        confidence: null,
        processing_time: +((performance.now() - start) / 1000).toFixed(3),
        engine_id: this.id,
        engine_name: this.name,
        error: null,
        metadata: {
          model: "mistral-ocr-latest",
          pages_processed: inputTokens,
          cost_usd: +cost.toFixed(6),
          pricing_per_1k_pages: PRICING.input,
          pricing_model: "per_page",
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

export const mistralOcr = new MistralOcrEngine();
