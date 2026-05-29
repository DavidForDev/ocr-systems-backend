import { Mistral } from "@mistralai/mistralai";
import {
  Engine,
  EngineResult,
  EnginePricing,
  Pipeline,
  SchemaField,
  emptyFields,
} from "./base.js";

/**
 * Mistral OCR with native structured output via `documentAnnotationFormat`.
 * One call: image → both raw markdown OCR and a structured object matching the
 * schema.
 */
const MODEL = "mistral-ocr-latest";

const secsSince = (start: number) => +((performance.now() - start) / 1000).toFixed(3);

class MistralOcrEngine extends Engine {
  id = "mistral-ocr";
  name = "Mistral OCR";
  description = "OCR + native document_annotation_format for structured fields.";

  async extract(imageBuffer: Buffer, schema: SchemaField[]): Promise<EngineResult> {
    const start = performance.now();
    const apiKey = process.env.MISTRAL_API_KEY;
    if (!apiKey) return this._fail(start, schema, "MISTRAL_API_KEY is not set");

    try {
      const client = new Mistral({ apiKey });
      const base64 = imageBuffer.toString("base64");
      const imageUrl = `data:image/png;base64,${base64}`;

      // JSON schema (draft-07 style) describing the fields we want back.
      const properties: Record<string, { type: "string"; description?: string }> = {};
      for (const f of schema) {
        properties[f.name] = {
          type: "string",
          ...(f.description ? { description: f.description } : {}),
        };
      }

      const documentAnnotationFormat = {
        type: "json_schema" as const,
        jsonSchema: {
          name: "extraction",
          description: "Fields extracted from the document",
          // Mistral expects the schema under `schemaDefinition`, not `schema`.
          schemaDefinition: {
            type: "object",
            properties,
            required: schema.map((f) => f.name),
            additionalProperties: false,
          },
          strict: true,
        },
      };

      const res: any = await (client as any).ocr.process({
        model: MODEL,
        document: { type: "image_url", imageUrl },
        documentAnnotationFormat,
      });

      const ocrText = (res.pages ?? [])
        .map((p: any) => p.markdown ?? "")
        .join("\n")
        .trim();

      // Result of structured annotation lands on response.documentAnnotation
      // (a JSON string per the API contract).
      const annRaw = res.documentAnnotation;
      let parsed: any = {};
      if (typeof annRaw === "string") {
        try { parsed = JSON.parse(annRaw); } catch { parsed = {}; }
      } else if (annRaw && typeof annRaw === "object") {
        parsed = annRaw;
      }

      const fields: Record<string, string | null> = {};
      for (const f of schema) {
        const v = (parsed[f.name] ?? "").toString().trim();
        fields[f.name] = v ? v : null;
      }

      return {
        fields,
        ocr_text: ocrText || null,
        processing_time: secsSince(start),
        error: null,
        metadata: { model: MODEL, page_count: res.pages?.length ?? 1 },
      };
    } catch (e: any) {
      return this._fail(start, schema, e?.message ?? "Mistral OCR failed");
    }
  }

  private _fail(start: number, schema: SchemaField[], msg: string): EngineResult {
    return {
      fields: emptyFields(schema),
      ocr_text: null,
      processing_time: secsSince(start),
      error: msg,
      metadata: {},
    };
  }

  pricing(): EnginePricing {
    return {
      components: [
        {
          label: "OCR pages",
          metadata_key: "page_count",
          unit_price_usd: 1.0 / 1_000, // $1.00 per 1k pages
          display_unit: "pages",
          display_rate: "$1.00 / 1k pages",
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
          subtitle: "data: URL, base64 PNG",
        },
        {
          id: "mistral",
          kind: "ocr",
          title: "Mistral OCR",
          provider: "Mistral",
          model: MODEL,
          details: [
            "Single API call performs OCR and structured extraction",
            "documentAnnotationFormat: jsonSchema (strict=true)",
            "Returns markdown OCR per page + documentAnnotation JSON string",
          ],
        },
        {
          id: "fields",
          kind: "output",
          title: "Structured fields + markdown OCR",
          subtitle: "{ field_name: value }",
        },
      ],
      edges: [
        {
          from: "image",
          to: "mistral",
          payload: "image_url (data:image/png;base64,…) + JSON schema",
        },
        {
          from: "mistral",
          to: "fields",
          payload: "pages[].markdown (OCR) + documentAnnotation (JSON string)",
        },
      ],
    };
  }
}

export const mistralOcr = new MistralOcrEngine();
