import { DocumentProcessorServiceClient } from "@google-cloud/documentai";
import { OCREngine, OCRResult } from "./base.js";

const PRICING = { perPage: 1.5 / 1000 };

class GoogleDocumentAIEngine extends OCREngine {
  id = "google-document-ai";
  name = "Google Document AI";
  provider = "Google";
  category = "Cloud OCR";

  private _client!: DocumentProcessorServiceClient;
  private _processorName!: string;

  protected async _lazyInit() {
    const projectId = process.env.GOOGLE_PROJECT_ID;
    const location = process.env.GOOGLE_LOCATION || "us";
    const processorId = process.env.GOOGLE_PROCESSOR_ID;

    if (!projectId || !processorId) {
      throw new Error("GOOGLE_PROJECT_ID and GOOGLE_PROCESSOR_ID environment variables are required");
    }

    const credentials = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON
      ? JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON)
      : undefined;

    this._client = credentials
      ? new DocumentProcessorServiceClient({ credentials })
      : new DocumentProcessorServiceClient();

    this._processorName = `projects/${projectId}/locations/${location}/processors/${processorId}`;
  }

  protected async _recognize(imageBuffer: Buffer): Promise<OCRResult> {
    const start = performance.now();
    try {
      const [result] = await this._client.processDocument({
        name: this._processorName,
        rawDocument: {
          content: imageBuffer.toString("base64"),
          mimeType: "image/png",
        },
      });

      const text = result.document?.text || "";
      const pages = result.document?.pages?.length ?? 1;
      const cost = pages * PRICING.perPage;

      return {
        text: text.trim(),
        confidence: null,
        processing_time: +((performance.now() - start) / 1000).toFixed(3),
        engine_id: this.id,
        engine_name: this.name,
        error: null,
        metadata: {
          pages_processed: pages,
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

export const googleDocumentAI = new GoogleDocumentAIEngine();
