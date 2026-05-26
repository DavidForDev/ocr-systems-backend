import { GoogleGenerativeAI } from "@google/generative-ai";

export async function extractFields(
  text: string,
  fields: string[]
): Promise<Record<string, string | null>> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return Object.fromEntries(fields.map((f) => [f, null]));

  try {
    const genai = new GoogleGenerativeAI(apiKey);
    const model = genai.getGenerativeModel({ model: "gemini-3.1-flash-lite" });

    const prompt = `Extract these fields from the text below. Return ONLY valid JSON with exactly these keys: ${JSON.stringify(fields)}. If a field is not found, set it to null.\n\nText:\n${text}`;

    const result = await model.generateContent(prompt);
    const raw = result.response.text() || "{}";

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return Object.fromEntries(fields.map((f) => [f, null]));

    const parsed = JSON.parse(jsonMatch[0]);
    const output: Record<string, string | null> = {};
    for (const f of fields) {
      output[f] = parsed[f] ?? null;
    }
    return output;
  } catch {
    return Object.fromEntries(fields.map((f) => [f, null]));
  }
}
