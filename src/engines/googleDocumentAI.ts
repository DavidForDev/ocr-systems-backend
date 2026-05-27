import fs from "node:fs";
import { DocumentProcessorServiceClient } from "@google-cloud/documentai";
import { OCREngine, OCRResult } from "./base.js";

const PRICING = { perPage: 1.5 / 1000 };

/**
 * Resolve a Google service-account credential from any of the supported env
 * vars. Accepts either inline JSON or a path to a JSON key file. The same
 * service account used for Vertex AI works here, provided it has Document AI
 * access (roles/documentai.apiUser). Returns undefined to fall back to ADC.
 */
function loadGoogleCredentials(): Record<string, unknown> | undefined {
  const raw =
    process.env.GOOGLE_VERTEX_CREDENTIALS ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!raw || !raw.trim()) return undefined;

  const value = raw.trim();
  const json = value.startsWith("{") ? value : fs.readFileSync(value, "utf8");
  return JSON.parse(json);
}

const OCR_PROCESSOR_TYPE = "OCR_PROCESSOR";

class GoogleDocumentAIEngine extends OCREngine {
  id = "google-document-ai";
  name = "Google Document AI";
  provider = "Google";
  category = "Cloud OCR";

  private _client!: DocumentProcessorServiceClient;
  private _processorName!: string;

  protected async _lazyInit() {
    const credentials = loadGoogleCredentials();
    const location = process.env.GOOGLE_LOCATION || "us";
    // Project can come from an explicit env var or straight from the
    // service-account JSON (its `project_id` field) — so GOOGLE_VERTEX_CREDENTIALS
    // alone is enough.
    const projectId =
      process.env.GOOGLE_PROJECT_ID ||
      (credentials?.project_id as string | undefined);

    if (!projectId) {
      throw new Error(
        "No Google project found. Set GOOGLE_VERTEX_CREDENTIALS to your " +
          "service-account JSON (it carries project_id), or set GOOGLE_PROJECT_ID."
      );
    }

    this._client = new DocumentProcessorServiceClient({
      ...(credentials ? { credentials } : {}),
      // Document AI requires a region-specific endpoint.
      apiEndpoint: `${location}-documentai.googleapis.com`,
    });

    // Use an explicit processor if given; otherwise discover or create an OCR
    // processor in the project so credentials alone are sufficient.
    const explicit = process.env.GOOGLE_PROCESSOR_ID;
    this._processorName = explicit
      ? `projects/${projectId}/locations/${location}/processors/${explicit}`
      : await this._resolveOcrProcessor(projectId, location);
  }

  /** Find an existing OCR processor in the project, or create one. */
  private async _resolveOcrProcessor(projectId: string, location: string): Promise<string> {
    const parent = `projects/${projectId}/locations/${location}`;
    try {
      const [processors] = await this._client.listProcessors({ parent });
      const ocr = processors.find((p) => p.type === OCR_PROCESSOR_TYPE && p.name);
      if (ocr?.name) return ocr.name;

      const [created] = await this._client.createProcessor({
        parent,
        processor: { type: OCR_PROCESSOR_TYPE, displayName: "ocr-studio-auto" },
      });
      if (!created?.name) throw new Error("processor created without a name");
      return created.name;
    } catch (e: any) {
      throw new Error(
        `Could not resolve a Document AI OCR processor in ${parent} ` +
          `(${e.message}). Either grant the service account roles/documentai.editor ` +
          `so it can list/create processors, or set GOOGLE_PROCESSOR_ID explicitly.`
      );
    }
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
