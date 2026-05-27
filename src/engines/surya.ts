import { OCREngine, OCRResult } from "./base.js";

// Surya is served via Datalab's hosted "convert" (Marker) API, which runs Surya
// under the hood. Async: submit returns a request_check_url you poll until done.
const BASE = "https://www.datalab.to/api/v1";
const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 45; // ~90s

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class SuryaEngine extends OCREngine {
  id = "surya";
  name = "Surya (Datalab)";
  provider = "Datalab";
  category = "Cloud OCR";

  private _apiKey!: string;

  protected async _lazyInit() {
    const key = process.env.DATALAB_API_KEY;
    if (!key || !key.trim()) {
      throw new Error("DATALAB_API_KEY environment variable is required");
    }
    this._apiKey = key.trim();
  }

  protected async _recognize(imageBuffer: Buffer): Promise<OCRResult> {
    const start = performance.now();
    const headers = { "X-API-Key": this._apiKey };
    try {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(imageBuffer)], { type: "image/png" }), "document.png");
      form.append("output_format", "markdown");
      form.append("mode", "balanced");

      const submitRes = await fetch(`${BASE}/convert`, { method: "POST", headers, body: form });
      const submit: any = await submitRes.json();
      if (!submitRes.ok || !submit?.success) {
        throw new Error(submit?.error || `Submit failed (HTTP ${submitRes.status})`);
      }

      const checkUrl: string = submit.request_check_url || `${BASE}/convert/${submit.request_id}`;

      let data: any = null;
      for (let i = 0; i < MAX_POLLS; i++) {
        await sleep(POLL_INTERVAL_MS);
        const r = await fetch(checkUrl, { headers });
        data = await r.json();
        if (data?.status === "complete") break;
      }

      if (!data || data.status !== "complete") {
        throw new Error("Timed out waiting for Surya/Datalab result");
      }
      if (!data.success) throw new Error(data.error || "Conversion failed");

      const text: string = data.markdown || "";
      const pages = data.page_count ?? 1;

      return {
        text: text.trim(),
        confidence: null,
        processing_time: +((performance.now() - start) / 1000).toFixed(3),
        engine_id: this.id,
        engine_name: this.name,
        error: null,
        metadata: {
          model: "surya / datalab-convert",
          pages_processed: pages,
          pricing_model: "per_page",
          runtime_s: data.runtime ?? null,
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

export const surya = new SuryaEngine();
