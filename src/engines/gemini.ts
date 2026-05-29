import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import {
  Engine,
  EngineResult,
  EnginePricing,
  Pipeline,
  SchemaField,
  emptyFields,
} from "./base.js";

const MODEL = "gemini-3.1-flash-lite";

const secsSince = (start: number) => +((performance.now() - start) / 1000).toFixed(3);

class GeminiEngine extends Engine {
  id = "gemini-flash-lite";
  name = "Gemini 3.1 Flash-Lite";
  description = "Vision LLM. One call: image → structured JSON (native responseSchema).";

  async extract(imageBuffer: Buffer, schema: SchemaField[]): Promise<EngineResult> {
    const start = performance.now();
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return this._fail(start, schema, "GEMINI_API_KEY is not set");

    const properties: Record<string, { type: SchemaType; description?: string }> = {};
    for (const f of schema) {
      properties[f.name] = {
        type: SchemaType.STRING,
        ...(f.description ? { description: f.description } : {}),
      };
    }

    try {
      const genai = new GoogleGenerativeAI(apiKey);
      const model = genai.getGenerativeModel({
        model: MODEL,
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: {
            type: SchemaType.OBJECT,
            properties,
            required: schema.map((f) => f.name),
          },
        },
      });

      const prompt =
        "Read this document and extract the requested fields. Return the exact value " +
        "as it appears. If a field isn't present, return an empty string for it. Do not guess.";

      const res = await model.generateContent([
        { inlineData: { mimeType: "image/png", data: imageBuffer.toString("base64") } },
        { text: prompt },
      ]);

      const parsed = JSON.parse(res.response.text() || "{}");
      const fields: Record<string, string | null> = {};
      for (const f of schema) {
        const v = (parsed[f.name] ?? "").toString().trim();
        fields[f.name] = v ? v : null;
      }

      const usage = (res.response as any).usageMetadata ?? {};
      return {
        fields,
        ocr_text: null,
        processing_time: secsSince(start),
        error: null,
        metadata: {
          model: MODEL,
          input_tokens: usage.promptTokenCount,
          output_tokens: usage.candidatesTokenCount,
          total_tokens: usage.totalTokenCount,
        },
      };
    } catch (e: any) {
      return this._fail(start, schema, e?.message ?? "Gemini failed");
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
          label: "Input tokens",
          metadata_key: "input_tokens",
          unit_price_usd: 0.10 / 1_000_000,
          display_unit: "tokens",
          display_rate: "$0.10 / 1M tokens",
        },
        {
          label: "Output tokens",
          metadata_key: "output_tokens",
          unit_price_usd: 0.40 / 1_000_000,
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
          subtitle: "PNG up to 4000×4000",
        },
        {
          id: "gemini",
          kind: "llm",
          title: "Gemini Vision LLM",
          provider: "Google",
          model: MODEL,
          details: [
            "Reads the image directly — no separate OCR step",
            "responseMimeType=application/json + responseSchema force valid JSON",
            "Prompt: 'Read this document and extract the requested fields...'",
          ],
        },
        {
          id: "fields",
          kind: "output",
          title: "Structured fields",
          subtitle: "{ field_name: value, ... }",
        },
      ],
      edges: [
        { from: "image", to: "gemini", payload: "inlineData (base64 PNG) + schema property list" },
        { from: "gemini", to: "fields", payload: "JSON object validated by responseSchema" },
      ],
    };
  }
}

export const gemini = new GeminiEngine();
