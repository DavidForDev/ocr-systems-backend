import fs from "node:fs";
import { DocumentProcessorServiceClient } from "@google-cloud/documentai";
import { OCREngine, OCRResult } from "./base.js";

const PRICING = { perPage: 1.5 / 1000 };

/**
 * Resolve service-account credentials for the client.
 *
 * Accepts inline JSON from GOOGLE_APPLICATION_CREDENTIALS_JSON, or — defensively
 * — inline JSON accidentally pasted into GOOGLE_APPLICATION_CREDENTIALS (which
 * ADC would otherwise try to stat as a file path, failing with ENAMETOOLONG).
 * A real file PATH in GOOGLE_APPLICATION_CREDENTIALS is left for ADC to load.
 * Returns undefined to fall back to ADC.
 */
function loadInlineCredentials(): Record<string, unknown> | undefined {
  for (const key of ["GOOGLE_APPLICATION_CREDENTIALS_JSON", "GOOGLE_APPLICATION_CREDENTIALS"]) {
    const raw = process.env[key];
    if (!raw || !raw.trim()) continue;
    const value = raw.trim();

    if (value.startsWith("{")) {
      // Inline JSON. If it was in GOOGLE_APPLICATION_CREDENTIALS, clear it so
      // the auth library doesn't treat the JSON blob as a filename.
      if (key === "GOOGLE_APPLICATION_CREDENTIALS") delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      return JSON.parse(value);
    }
    // A path supplied via the _JSON var — read it; a path in
    // GOOGLE_APPLICATION_CREDENTIALS is handled by ADC, so skip it here.
    if (key === "GOOGLE_APPLICATION_CREDENTIALS_JSON") {
      return JSON.parse(fs.readFileSync(value, "utf8"));
    }
  }
  return undefined;
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
    // Trim every env value — copy/paste into hosting dashboards (e.g. Railway)
    // often leaves a trailing space or newline, which makes the processor name
    // invalid and yields "INVALID_ARGUMENT" from Document AI.
    const env = (k: string): string | undefined =>
      (process.env[k] ?? "").trim() || undefined;

    const inlineCreds = loadInlineCredentials();
    const location =
      env("GOOGLE_DOCUMENTAI_LOCATION") || env("GOOGLE_LOCATION") || "us";

    this._client = new DocumentProcessorServiceClient({
      // When no inline creds are given, the client authenticates via ADC
      // (GOOGLE_APPLICATION_CREDENTIALS).
      ...(inlineCreds ? { credentials: inlineCreds } : {}),
      // Document AI requires a region-specific endpoint.
      apiEndpoint: `${location}-documentai.googleapis.com`,
    });

    // Project: explicit env var, else inline creds, else resolved from ADC.
    let projectId =
      env("GOOGLE_DOCUMENTAI_PROJECT_ID") ||
      env("GOOGLE_PROJECT_ID") ||
      (inlineCreds?.project_id as string | undefined)?.trim();
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
      env("GOOGLE_DOCUMENTAI_PROCESSOR_ID") || env("GOOGLE_PROCESSOR_ID");
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
