import sharp from "sharp";
import { DocumentProcessorServiceClient } from "@google-cloud/documentai";
import {
  Engine,
  EngineResult,
  EnginePricing,
  Pipeline,
  SchemaField,
  emptyFields,
} from "./base.js";
import { loadInlineCredentials } from "../utils/googleCreds.js";
import { extractFromText, EXTRACTOR_MODEL } from "../utils/structuredOutput.js";

/**
 * Google Document AI's Document OCR processor for layout-aware OCR, then
 * Gemini with responseSchema to produce structured fields. Document AI is
 * particularly good at scanned/photographed paper forms.
 */
const secsSince = (start: number) => +((performance.now() - start) / 1000).toFixed(3);

class GoogleDocumentAIEngine extends Engine {
  id = "google-document-ai";
  name = "Google Document AI + Gemini";
  description = "Document AI OCR (layout-aware) → Gemini structured output.";

  private _client!: DocumentProcessorServiceClient;
  private _processorName: string | null = null;

  protected async _lazyInit() {
    const env = (k: string) => (process.env[k] ?? "").trim() || undefined;
    const creds = loadInlineCredentials();
    const location = env("GOOGLE_DOCUMENTAI_LOCATION") || "us";
    const projectId =
      env("GOOGLE_DOCUMENTAI_PROJECT_ID") ||
      (creds?.project_id as string | undefined)?.trim();
    const processorId = env("GOOGLE_DOCUMENTAI_PROCESSOR_ID");

    if (!projectId || !processorId) {
      // Lazy: defer the error to extract() so other engines still work.
      return;
    }

    this._client = new DocumentProcessorServiceClient({
      ...(creds ? { credentials: creds } : {}),
      apiEndpoint: `${location}-documentai.googleapis.com`,
    });
    this._processorName = `projects/${projectId}/locations/${location}/processors/${processorId}`;
  }

  async extract(imageBuffer: Buffer, schema: SchemaField[]): Promise<EngineResult> {
    await this.ensureInitialized();
    const start = performance.now();
    if (this._initError) {
      return {
        fields: emptyFields(schema),
        ocr_text: null,
        processing_time: secsSince(start),
        error: this._initError,
        metadata: {},
      };
    }
    if (!this._processorName) {
      return {
        fields: emptyFields(schema),
        ocr_text: null,
        processing_time: secsSince(start),
        error:
          "Document AI not configured. Set GOOGLE_DOCUMENTAI_PROJECT_ID + " +
          "GOOGLE_DOCUMENTAI_PROCESSOR_ID (Document OCR processor).",
        metadata: {},
      };
    }

    try {
      // Downscale + JPEG to stay safely under online-processing limits.
      const content = await sharp(imageBuffer)
        .resize(3000, 3000, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 90 })
        .toBuffer();

      const [result] = await this._client.processDocument({
        name: this._processorName,
        rawDocument: { content, mimeType: "image/jpeg" },
      });

      // Log the entire Document AI response for inspection (gated — these dumps
      // are MBs per image and flood production logs).
      if (process.env.DEBUG_DOCAI === "1") {
        const dumped = JSON.stringify(
          result,
          (_k, v) => (v && v.type === "Buffer" ? `<Buffer ${v.data?.length ?? "?"}B>` : v),
          2
        );
        console.log(
          `[google-document-ai] processDocument response (${dumped.length} chars):\n${dumped}`
        );
      }

      const text = (result.document?.text ?? "").trim();
      const pages = result.document?.pages?.length ?? 1;

      const llm = await extractFromText(text, schema);

      return {
        fields: llm.fields,
        ocr_text: text || null,
        processing_time: secsSince(start),
        // Surface a Gemini-side failure (e.g. quota, JSON parse error) so the
        // UI can show the row as errored instead of silently empty.
        error: llm.error,
        metadata: {
          provider: "google-document-ai",
          pages_processed: pages,
          gemini_input_tokens: llm.input_tokens,
          gemini_output_tokens: llm.output_tokens,
        },
      };
    } catch (e: any) {
      return {
        fields: emptyFields(schema),
        ocr_text: null,
        processing_time: secsSince(start),
        error: describeGrpcError(e),
        metadata: {},
      };
    }
  }

  pricing(): EnginePricing {
    return {
      components: [
        {
          label: "Document AI pages",
          metadata_key: "pages_processed",
          unit_price_usd: 1.5 / 1_000, // $1.50 per 1k pages (Document OCR)
          display_unit: "pages",
          display_rate: "$1.50 / 1k pages",
        },
        {
          label: "Gemini input tokens",
          metadata_key: "gemini_input_tokens",
          unit_price_usd: 0.10 / 1_000_000, // $0.10 / 1M tokens
          display_unit: "tokens",
          display_rate: "$0.10 / 1M tokens",
        },
        {
          label: "Gemini output tokens",
          metadata_key: "gemini_output_tokens",
          unit_price_usd: 0.40 / 1_000_000, // $0.40 / 1M tokens
          display_unit: "tokens",
          display_rate: "$0.40 / 1M tokens",
        },
      ],
    };
  }

  pipeline(): Pipeline {
    return {
      nodes: [
        {
          id: "image",
          kind: "input",
          title: "Document image",
          subtitle: "Resized to ≤3000×3000 JPEG (q=90)",
        },
        {
          id: "docai",
          kind: "ocr",
          title: "Google Document AI",
          provider: "Google Cloud",
          model: "Document OCR processor",
          details: [
            "processDocument(rawDocument)",
            "Layout-aware OCR — great on scans & photographed forms",
            "Returns plain text (document.text) + page count",
          ],
        },
        {
          id: "gemini",
          kind: "llm",
          title: "Gemini",
          provider: "Google",
          model: EXTRACTOR_MODEL,
          details: [
            "Receives the OCR text — does not see the image",
            "responseMimeType=application/json + responseSchema enforce field shape",
            "Prompt: 'Extract the requested fields from the text below...'",
          ],
        },
        {
          id: "fields",
          kind: "output",
          title: "Structured fields",
          subtitle: "{ field_name: value, ... } + raw OCR text",
        },
      ],
      edges: [
        { from: "image", to: "docai", payload: "rawDocument.content (JPEG bytes)" },
        { from: "docai", to: "gemini", payload: "document.text (plain string) + field name/description list" },
        { from: "gemini", to: "fields", payload: "JSON object validated by responseSchema" },
      ],
    };
  }
}

function describeGrpcError(e: any): string {
  const base = e?.message || "Document AI failed";
  const details = e?.statusDetails;
  if (!Array.isArray(details) || !details.length) return base;
  const parts: string[] = [];
  for (const d of details) {
    if (Array.isArray(d?.fieldViolations))
      for (const v of d.fieldViolations) parts.push(`${v.field}: ${v.description}`);
    else if (d?.reason) parts.push(d.reason);
  }
  return parts.length ? `${base} — ${parts.join("; ")}` : base;
}

export const googleDocumentAI = new GoogleDocumentAIEngine();
