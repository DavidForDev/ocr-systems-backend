import fs from "node:fs";
import { DocumentProcessorServiceClient } from "@google-cloud/documentai";
import { OCREngine, OCRResult } from "./base.js";

const PRICING = { perPage: 1.5 / 1000 };

/**
 * Optional inline credentials via GOOGLE_APPLICATION_CREDENTIALS_JSON (handy on
 * platforms where you can't ship a key file). Accepts inline JSON or a path.
 * When unset, the client uses Application Default Credentials — i.e. the file
 * pointed to by GOOGLE_APPLICATION_CREDENTIALS. Returns undefined for ADC.
 */
function loadInlineCredentials(): Record<string, unknown> | undefined {
  const raw = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
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
    const inlineCreds = loadInlineCredentials();
    const location =
      process.env.GOOGLE_DOCUMENTAI_LOCATION || process.env.GOOGLE_LOCATION || "us";

    this._client = new DocumentProcessorServiceClient({
      // When no inline creds are given, the client authenticates via ADC
      // (GOOGLE_APPLICATION_CREDENTIALS).
      ...(inlineCreds ? { credentials: inlineCreds } : {}),
      // Document AI requires a region-specific endpoint.
      apiEndpoint: `${location}-documentai.googleapis.com`,
    });

    // Project: explicit env var, else inline creds, else resolved from ADC.
    let projectId =
      process.env.GOOGLE_DOCUMENTAI_PROJECT_ID ||
      process.env.GOOGLE_PROJECT_ID ||
      (inlineCreds?.project_id as string | undefined);
    if (!projectId) projectId = await this._client.getProjectId();

    if (!projectId) {
      throw new Error(
        "No Google project found. Set GOOGLE_DOCUMENTAI_PROJECT_ID, or point " +
          "GOOGLE_APPLICATION_CREDENTIALS at a service-account key file."
      );
    }

    // Use an explicit processor if given; otherwise discover or create an OCR
    // processor in the project.
    const explicit =
      process.env.GOOGLE_DOCUMENTAI_PROCESSOR_ID || process.env.GOOGLE_PROCESSOR_ID;
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
