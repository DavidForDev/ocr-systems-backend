import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";

const MODEL = "gemini-3.1-flash-lite";

export interface ExtractField {
  name: string;
  description?: string;
}

/**
 * Pull structured field values out of OCR text using Gemini's native
 * `responseSchema` (no fragile regex/JSON parsing).
 *
 * Returns null for fields the model couldn't find (empty strings collapse to
 * null to match how the rest of the UI renders "not found").
 */
export async function extractFields(
  text: string,
  fields: Array<ExtractField | string>,
  descriptions?: Record<string, string>
): Promise<Record<string, string | null>> {
  const normalized: ExtractField[] = fields.map((f) =>
    typeof f === "string" ? { name: f, description: descriptions?.[f] } : { ...f, description: f.description ?? descriptions?.[f.name] }
  );

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return Object.fromEntries(normalized.map((f) => [f.name, null]));

  const properties: Record<string, { type: SchemaType; description?: string }> = {};
  for (const f of normalized) {
    properties[f.name] = {
      type: SchemaType.STRING,
      ...(f.description ? { description: f.description } : {}),
    };
  }

  const fieldList = normalized
    .map((f) => (f.description ? `${f.name} (${f.description})` : f.name))
    .join(", ");

  const prompt =
    "Extract the requested fields from the text below. Return the exact value as it " +
    "appears in the text. If a field is not mentioned, return an empty string for it. " +
    "Do not guess.\n\n" +
    `Fields to extract: ${fieldList}\n\nText:\n${text}`;

  try {
    const genai = new GoogleGenerativeAI(apiKey);
    const model = genai.getGenerativeModel({
      model: MODEL,
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: SchemaType.OBJECT,
          properties,
          required: normalized.map((f) => f.name),
        },
      },
    });

    const result = await model.generateContent(prompt);
    const raw = result.response.text() || "{}";
    const parsed = JSON.parse(raw);

    const output: Record<string, string | null> = {};
    for (const f of normalized) {
      const v = (parsed[f.name] ?? "").toString().trim();
      output[f.name] = v.length ? v : null;
    }
    return output;
  } catch {
    return Object.fromEntries(normalized.map((f) => [f.name, null]));
  }
}
