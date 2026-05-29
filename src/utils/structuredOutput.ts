/**
 * Run Gemini with a strict responseSchema to pull schema-defined fields out of
 * arbitrary OCR text. Used by the two-step engines (Google Vision + Gemini,
 * Google Document AI OCR + Gemini).
 */
import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { SchemaField, emptyFields } from "../engines/base.js";

const MODEL = "gemini-3.1-flash-lite";
export const EXTRACTOR_MODEL = MODEL;

export interface ExtractFromTextResult {
  fields: Record<string, string | null>;
  input_tokens: number;
  output_tokens: number;
}

export async function extractFromText(
  text: string,
  schema: SchemaField[]
): Promise<ExtractFromTextResult> {
  const empty: ExtractFromTextResult = {
    fields: emptyFields(schema),
    input_tokens: 0,
    output_tokens: 0,
  };
  if (!schema.length || !text.trim()) return empty;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return empty;

  const properties: Record<string, { type: SchemaType; description?: string }> = {};
  for (const f of schema) {
    properties[f.name] = {
      type: SchemaType.STRING,
      ...(f.description ? { description: f.description } : {}),
    };
  }

  const fieldList = schema
    .map((f) => (f.description ? `${f.name} (${f.description})` : f.name))
    .join(", ");
  const prompt =
    "Extract the requested fields from the text below. Return the exact value as it " +
    "appears in the text. If a field is not mentioned, return an empty string for it. " +
    "Do not guess.\n\n" +
    `Fields: ${fieldList}\n\nText:\n${text}`;

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
    const res = await model.generateContent(prompt);
    const parsed = JSON.parse(res.response.text() || "{}");
    const fields: Record<string, string | null> = {};
    for (const f of schema) {
      const v = (parsed[f.name] ?? "").toString().trim();
      fields[f.name] = v ? v : null;
    }
    const usage = (res.response as any).usageMetadata ?? {};
    return {
      fields,
      input_tokens: usage.promptTokenCount ?? 0,
      output_tokens: usage.candidatesTokenCount ?? 0,
    };
  } catch {
    return empty;
  }
}
