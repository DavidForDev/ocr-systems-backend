import { Router, Request, Response } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { ObjectId, Db } from "mongodb";
import { getDB } from "../db.js";
import { getEngine } from "../engines/index.js";
import { extractFields, ExtractField } from "../utils/schemaExtractor.js";
import { UPLOADS_DIR } from "./ocr.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_DIR = path.resolve(__dirname, "../../seed");

const router = Router();
const BATCH_SIZE = 3;

/** ── Datasets ─────────────────────────────────────────────────── */

router.get("/datasets", async (_req: Request, res: Response) => {
  try {
    const db = getDB();
    if (!db) return void res.json({ datasets: [] });
    const docs = await db.collection("datasets").find({}).sort({ created_at: -1 }).toArray();
    res.json({
      datasets: docs.map((d: any) => ({
        id: d._id.toString(),
        slug: d.slug,
        name: d.name,
        description: d.description,
        builtin: !!d.builtin,
        field_count: d.field_schema?.length ?? 0,
        item_count: d.items?.length ?? 0,
        created_at: d.created_at,
      })),
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/datasets/:id", async (req: Request, res: Response) => {
  try {
    const db = getDB();
    if (!db) return void res.status(404).json({ error: "Database not available" });

    const doc = await loadDataset(db, req.params.id);
    if (!doc) return void res.status(404).json({ error: "Not found" });
    res.json({ id: doc._id.toString(), ...doc, _id: undefined });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** ── Eval runs ────────────────────────────────────────────────── */

router.get("/evals/runs", async (_req: Request, res: Response) => {
  try {
    const db = getDB();
    if (!db) return void res.json({ runs: [] });
    const docs = await db
      .collection("eval_runs")
      .find({})
      .project({ results: 0 }) // omit heavy field
      .sort({ created_at: -1 })
      .limit(50)
      .toArray();
    res.json({
      runs: docs.map((d: any) => ({
        id: d._id.toString(),
        dataset_id: d.dataset_id?.toString(),
        dataset_name: d.dataset_name,
        engine_ids: d.engine_ids,
        status: d.status,
        summary: d.summary ?? null,
        created_at: d.created_at,
        completed_at: d.completed_at ?? null,
      })),
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/evals/runs/:id", async (req: Request, res: Response) => {
  try {
    const db = getDB();
    if (!db) return void res.status(404).json({ error: "Database not available" });
    let oid: ObjectId;
    try { oid = new ObjectId(req.params.id); } catch { return void res.status(400).json({ error: "Invalid id" }); }
    const doc = await db.collection("eval_runs").findOne({ _id: oid });
    if (!doc) return void res.status(404).json({ error: "Not found" });
    res.json({ id: doc._id.toString(), ...doc, _id: undefined });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/evals/run", async (req: Request, res: Response) => {
  try {
    const db = getDB();
    if (!db) return void res.status(503).json({ error: "Database not available — eval runs need MongoDB" });

    const { dataset_id, engine_ids } = req.body || {};
    if (!dataset_id || !Array.isArray(engine_ids) || engine_ids.length === 0) {
      return void res.status(400).json({ error: "dataset_id and engine_ids[] are required" });
    }

    const dataset = await loadDataset(db, dataset_id);
    if (!dataset) return void res.status(404).json({ error: "Dataset not found" });

    const engines = engine_ids
      .map((id: string) => getEngine(id))
      .filter((e): e is NonNullable<typeof e> => e != null);
    if (engines.length === 0) return void res.status(400).json({ error: "No valid engines" });

    const oid = new ObjectId();
    const initial = engines.map((e) => ({
      engine_id: e.id,
      engine_name: e.name,
      items: [] as ItemResult[],
      summary: { items: 0, passed: 0, failed: 0, accuracy: 0, avg_seconds: 0, min_seconds: 0, max_seconds: 0 },
      done: false,
    }));

    await db.collection("eval_runs").insertOne({
      _id: oid,
      dataset_id: dataset._id,
      dataset_name: dataset.name,
      engine_ids: engines.map((e) => e.id),
      total_items: dataset.items.length,
      status: "running",
      results: initial,
      summary: null,
      created_at: new Date(),
      completed_at: null,
    } as any);

    // Fire-and-forget background processing.
    runEvalInBackground(db, oid, dataset, engines).catch((err) => {
      console.error("[evals] background run failed:", err);
      db.collection("eval_runs").updateOne(
        { _id: oid },
        { $set: { status: "error", error: err?.message ?? String(err), completed_at: new Date() } }
      );
    });

    res.json({ id: oid.toString(), status: "running" });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** ── Helpers ──────────────────────────────────────────────────── */

interface ItemResult {
  item_id: string;
  item_name: string;
  ocr_text: string;
  ocr_seconds: number;
  ocr_confidence: number | null;
  error: string | null;
  extracted: Record<string, string | null>;
  checks: { field: string; expected: string[]; actual: string; match: boolean }[];
  correct: number;
  total: number;
  accuracy: number;
  passed: boolean;
}

async function loadDataset(db: Db, id: string) {
  try {
    const oid = new ObjectId(id);
    return await db.collection("datasets").findOne({ _id: oid });
  } catch {
    return null;
  }
}

async function loadImageBytes(image_url: string): Promise<Buffer> {
  if (!image_url) throw new Error("Item has no image_url");

  // Map the public URL back to a filesystem path.
  let absSrc: string;
  if (image_url.startsWith("/seed/")) {
    absSrc = path.join(SEED_DIR, image_url.slice("/seed/".length));
  } else if (image_url.startsWith("/uploads/")) {
    absSrc = path.join(UPLOADS_DIR, image_url.slice("/uploads/".length));
  } else {
    throw new Error(`Unsupported image_url: ${image_url}`);
  }

  const raw = await fs.readFile(absSrc);
  // Normalize to a sensible PNG to avoid engine-specific format quirks.
  return sharp(raw)
    .resize(4000, 4000, { fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();
}

function normalize(s: string): string {
  return (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function matchField(
  actual: string,
  expected: string[],
  requireAll: boolean
): boolean {
  // No expected values means "this field shouldn't appear in the document" —
  // the model passes only if it extracted nothing.
  const effective = expected.length ? expected : [""];
  const a = normalize(actual);
  const values = effective.map(normalize);
  const test = (v: string) => (v === "" ? a === "" : a.includes(v));
  return requireAll ? values.every(test) : values.some(test);
}

function statsFor(items: ItemResult[]) {
  if (!items.length) {
    return { items: 0, passed: 0, failed: 0, accuracy: 0, avg_seconds: 0, min_seconds: 0, max_seconds: 0 };
  }
  const round = (n: number) => Math.round(n * 100) / 100;
  const seconds = items.map((i) => i.ocr_seconds);
  const passed = items.filter((i) => i.passed).length;
  const accuracySum = items.reduce((s, i) => s + i.accuracy, 0);
  return {
    items: items.length,
    passed,
    failed: items.length - passed,
    accuracy: round(accuracySum / items.length),
    avg_seconds: round(seconds.reduce((a, b) => a + b, 0) / seconds.length),
    min_seconds: round(Math.min(...seconds)),
    max_seconds: round(Math.max(...seconds)),
  };
}

async function runEvalInBackground(
  db: Db,
  runId: ObjectId,
  dataset: any,
  engines: Array<{ id: string; name: string; recognize: (b: Buffer) => Promise<any> }>
) {
  const fieldSchema = (dataset.field_schema ?? []) as Array<{
    name: string;
    description?: string;
    requireAllValues?: boolean;
  }>;
  const fields: ExtractField[] = fieldSchema.map((f) => ({
    name: f.name,
    description: f.description,
  }));

  for (const engine of engines) {
    const items = dataset.items as Array<{
      id: string;
      name: string;
      image_url: string;
      ground_truth: Record<string, string[]>;
    }>;

    const collected: ItemResult[] = [];
    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      const batch = items.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async (item): Promise<ItemResult> => {
          try {
            const buf = await loadImageBytes(item.image_url);
            const r = await engine.recognize(buf);
            const ocrText: string = r.text ?? "";
            let extracted: Record<string, string | null> = {};
            if (ocrText.length > 0) {
              extracted = await extractFields(ocrText, fields);
            } else {
              extracted = Object.fromEntries(fields.map((f) => [f.name, null]));
            }
            const checks = fieldSchema.map((f) => {
              const expected = item.ground_truth[f.name] ?? [];
              const actual = extracted[f.name] ?? "";
              return {
                field: f.name,
                expected,
                actual,
                match: matchField(actual, expected, !!f.requireAllValues),
              };
            });
            const correct = checks.filter((c) => c.match).length;
            return {
              item_id: item.id,
              item_name: item.name,
              ocr_text: ocrText,
              ocr_seconds: typeof r.processing_time === "number" ? r.processing_time : 0,
              ocr_confidence: r.confidence ?? null,
              error: r.error ?? null,
              extracted,
              checks,
              correct,
              total: checks.length,
              accuracy: checks.length === 0 ? 0 : correct / checks.length,
              passed: correct === checks.length,
            };
          } catch (e: any) {
            return {
              item_id: item.id,
              item_name: item.name,
              ocr_text: "",
              ocr_seconds: 0,
              ocr_confidence: null,
              error: e?.message ?? String(e),
              extracted: {},
              checks: [],
              correct: 0,
              total: fieldSchema.length,
              accuracy: 0,
              passed: false,
            };
          }
        })
      );

      collected.push(...batchResults);

      // Incremental persistence — frontend can poll and see progress.
      await db.collection("eval_runs").updateOne(
        { _id: runId, "results.engine_id": engine.id },
        {
          $set: {
            "results.$.items": collected,
            "results.$.summary": statsFor(collected),
          },
        }
      );
    }

    await db.collection("eval_runs").updateOne(
      { _id: runId, "results.engine_id": engine.id },
      { $set: { "results.$.done": true } }
    );
  }

  // Final overall summary across engines.
  const fresh = await db.collection("eval_runs").findOne({ _id: runId });
  const overall = {
    engines: fresh?.results?.length ?? 0,
    items: fresh?.total_items ?? 0,
    best_engine: pickBestEngine(fresh?.results ?? []),
  };
  await db
    .collection("eval_runs")
    .updateOne(
      { _id: runId },
      { $set: { status: "complete", completed_at: new Date(), summary: overall } }
    );
}

function pickBestEngine(results: any[]): { engine_id: string; accuracy: number } | null {
  if (!results?.length) return null;
  let best: { engine_id: string; accuracy: number } | null = null;
  for (const r of results) {
    const acc = r?.summary?.accuracy ?? 0;
    if (!best || acc > best.accuracy) best = { engine_id: r.engine_id, accuracy: acc };
  }
  return best;
}

export default router;
