import sharp from "sharp";
import { DocumentProcessorServiceClient } from "@google-cloud/documentai";
import { OCREngine, OCRResult } from "./base.js";
import { loadInlineCredentials } from "../utils/googleCreds.js";

const PRICING = { perPage: 1.5 / 1000 };

/**
 * Pull the human-readable field violations out of a gRPC error so a bare
 * "INVALID_ARGUMENT" tells us *what* was actually wrong.
 */
function describeGrpcError(e: any): string {
  const base = e?.message || "Unknown error";
  const details = e?.statusDetails;
  if (!Array.isArray(details) || !details.length) return base;

  const parts: string[] = [];
  for (const d of details) {
    if (Array.isArray(d?.fieldViolations)) {
      for (const v of d.fieldViolations) parts.push(`${v.field}: ${v.description}`);
    } else if (d?.reason) {
      parts.push(d.reason);
    } else if (d?.description) {
      parts.push(d.description);
    }
  }
  return parts.length ? `${base} — ${parts.join("; ")}` : base;
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
      ? await this._ensureOcr(
          `projects/${projectId}/locations/${location}/processors/${explicit}`,
          projectId,
          location
        )
      : await this._resolveOcrProcessor(projectId, location);
  }

  /**
   * Confirm the configured processor is a Document OCR processor. A Custom
   * Extractor / Form processor rejects OCR requests with "entity_types: Must
   * have at least one entity type". If it's the wrong type, fall back to a real
   * OCR processor. If we can't verify (e.g. no get permission), use it as-is.
   */
  private async _ensureOcr(name: string, projectId: string, location: string): Promise<string> {
    try {
      const [proc] = await this._client.getProcessor({ name });
      if (proc?.type && proc.type !== OCR_PROCESSOR_TYPE) {
        console.warn(
          `Document AI processor is type ${proc.type}, not ${OCR_PROCESSOR_TYPE}; ` +
            `resolving an OCR processor instead.`
        );
        return this._resolveOcrProcessor(projectId, location);
      }
      return name;
    } catch {
      return name;
    }
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
      // Re-encode to a modest JPEG. Document AI online processing is strict
      // about request size; a downscaled JPEG keeps us well within limits and
      // is a fully supported input format.
      const content = await sharp(imageBuffer)
        .resize(3000, 3000, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 90 })
        .toBuffer();

      const [result] = await this._client.processDocument({
        name: this._processorName,
        rawDocument: {
          content, // raw bytes — let the client handle encoding
          mimeType: "image/jpeg",
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
      let message = describeGrpcError(e);
      // The hallmark of pointing at a Custom Extractor/Form processor instead
      // of a Document OCR processor — give an actionable message.
      if (/entity[_ ]?type/i.test(message)) {
        message =
          "GOOGLE_DOCUMENTAI_PROCESSOR_ID points to a non-OCR processor (a Custom " +
          "Extractor/Form processor). Create a 'Document OCR' processor in the " +
          "Document AI console and set GOOGLE_DOCUMENTAI_PROCESSOR_ID to its id — or " +
          "remove that variable and grant the service account roles/documentai.editor " +
          "so an OCR processor can be created automatically.";
      }
      return {
        text: "",
        confidence: null,
        processing_time: +((performance.now() - start) / 1000).toFixed(3),
        engine_id: this.id,
        engine_name: this.name,
        error: message,
        metadata: {},
      };
    }
  }
}

export const googleDocumentAI = new GoogleDocumentAIEngine();
