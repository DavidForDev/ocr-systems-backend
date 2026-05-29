import fs from "node:fs";

/**
 * Resolve service-account credentials for any Google Cloud client.
 *
 * Reads, in order:
 *  - GOOGLE_APPLICATION_CREDENTIALS_JSON  (inline JSON or path)
 *  - GOOGLE_APPLICATION_CREDENTIALS       (path; or inline JSON pasted by mistake)
 *
 * Defensively normalises common copy-paste damage (BOM, smart quotes, leading
 * whitespace) before parsing, and throws with a clear message if the JSON is
 * still invalid — that way the engine result shows the real reason instead of
 * a raw "Expected property name…" parser error.
 *
 * Returns undefined to fall back to Application Default Credentials.
 */
export function loadInlineCredentials(): Record<string, unknown> | undefined {
  for (const key of ["GOOGLE_APPLICATION_CREDENTIALS_JSON", "GOOGLE_APPLICATION_CREDENTIALS"]) {
    const raw = process.env[key];
    if (!raw || !raw.trim()) continue;

    const cleaned = sanitise(raw);
    if (cleaned.startsWith("{")) {
      // Inline JSON. If it was in GOOGLE_APPLICATION_CREDENTIALS, clear it so
      // ADC doesn't also try to treat the JSON blob as a filename.
      if (key === "GOOGLE_APPLICATION_CREDENTIALS") {
        delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      }
      return parseOrExplain(cleaned, key);
    }
    if (key === "GOOGLE_APPLICATION_CREDENTIALS_JSON") {
      const fileBody = sanitise(fs.readFileSync(cleaned, "utf8"));
      return parseOrExplain(fileBody, `${key} (file: ${cleaned})`);
    }
    // GOOGLE_APPLICATION_CREDENTIALS as a real path — leave for ADC.
  }
  return undefined;
}

/** Strip BOM, zero-width chars, and replace typographic quotes that often
 *  sneak in when JSON is pasted out of a docs/messaging app. */
function sanitise(s: string): string {
  return s
    .replace(/^﻿/, "")          // UTF-8 BOM
    .replace(/[​-‏‪-‮⁠]/g, "") // zero-widths / bidi
    .replace(/[‘’]/g, "'") // curly single quotes
    .replace(/[“”]/g, '"') // curly double quotes
    .trim();
}

function parseOrExplain(json: string, source: string): Record<string, unknown> {
  try {
    return JSON.parse(json);
  } catch (e: any) {
    throw new Error(
      `Could not parse ${source} as JSON — ${e?.message ?? "invalid JSON"}. ` +
        `Check that the env var contains a valid service-account JSON object ` +
        `(starts with "{", ends with "}", and all keys/strings use straight double quotes).`
    );
  }
}
