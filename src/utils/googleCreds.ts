import fs from "node:fs";

/**
 * Resolve service-account credentials for any Google Cloud client.
 *
 * Reads, in order:
 *  - GOOGLE_APPLICATION_CREDENTIALS_JSON (inline JSON or path)
 *  - GOOGLE_APPLICATION_CREDENTIALS — if it accidentally contains inline JSON
 *    (a common Railway footgun), parse it and unset it so ADC doesn't try to
 *    stat the JSON blob as a filename. A real path is left for ADC.
 *
 * Returns undefined to fall back to Application Default Credentials.
 */
export function loadInlineCredentials(): Record<string, unknown> | undefined {
  for (const key of ["GOOGLE_APPLICATION_CREDENTIALS_JSON", "GOOGLE_APPLICATION_CREDENTIALS"]) {
    const raw = process.env[key];
    if (!raw || !raw.trim()) continue;
    const value = raw.trim();

    if (value.startsWith("{")) {
      if (key === "GOOGLE_APPLICATION_CREDENTIALS") delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      return JSON.parse(value);
    }
    if (key === "GOOGLE_APPLICATION_CREDENTIALS_JSON") {
      return JSON.parse(fs.readFileSync(value, "utf8"));
    }
  }
  return undefined;
}
