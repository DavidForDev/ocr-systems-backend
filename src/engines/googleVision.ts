import { ImageAnnotatorClient } from "@google-cloud/vision";
import { OCREngine, OCRResult } from "./base.js";
import { loadInlineCredentials } from "../utils/googleCreds.js";

// Google Vision documentTextDetection — dense-text OCR. Same pricing tier as
// Document AI (≈ $1.50 / 1k pages); no processor to set up.
const PRICING = { perPage: 1.5 / 1000 };

class GoogleVisionEngine extends OCREngine {
  id = "google-vision";
  name = "Google Vision OCR";
  provider = "Google";
  category = "Cloud OCR";

  private _client!: ImageAnnotatorClient;

  protected async _lazyInit() {
    const credentials = loadInlineCredentials();
    this._client = new ImageAnnotatorClient(
      credentials
        ? { credentials, projectId: credentials.project_id as string | undefined }
        : {}
    );
  }

  protected async _recognize(imageBuffer: Buffer): Promise<OCRResult> {
    const start = performance.now();
    try {
      const [result] = await this._client.documentTextDetection({
        image: { content: imageBuffer },
      });

      const pages = result.fullTextAnnotation?.pages ?? [];
      const confs = pages
        .map((p: { confidence?: number | null }) => p.confidence)
        .filter((c: unknown): c is number => typeof c === "number");
      const confidence = confs.length
        ? Math.round((100 * confs.reduce((a: number, b: number) => a + b, 0)) / confs.length)
        : null;

      const text =
        result.fullTextAnnotation?.text ??
        result.textAnnotations?.[0]?.description ??
        "";
      const pageCount = pages.length || 1;
      const cost = pageCount * PRICING.perPage;

      return {
        text: text.trim(),
        confidence,
        processing_time: +((performance.now() - start) / 1000).toFixed(3),
        engine_id: this.id,
        engine_name: this.name,
        error: null,
        metadata: {
          pages_processed: pageCount,
          cost_usd: +cost.toFixed(6),
          pricing_per_1k_pages: 1.5,
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

export const googleVision = new GoogleVisionEngine();
