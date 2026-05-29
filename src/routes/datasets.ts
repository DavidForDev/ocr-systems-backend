import { Router, Request, Response } from "express";
import multer from "multer";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { ObjectId, Db } from "mongodb";
import { getDB } from "../db.js";
import { deleteByUrl, putObject } from "../storage.js";
import { getEngine } from "../engines/index.js";

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

interface SchemaField {
  name: string;
  description?: string;
  expected_values?: string[];
}

/** Coerce legacy single-string `expected_value` and the new
 *  `expected_values: string[]` into a canonical, non-empty trimmed array. */
function coerceExpectedValues(f: any): string[] {
  const out: string[] = [];
  const push = (v: any) => {
    if (typeof v !== "string") v = v == null ? "" : String(v);
    const t = v.trim();
    if (t) out.push(t);
  };
  if (Array.isArray(f?.expected_values)) for (const v of f.expected_values) push(v);
  if (Array.isArray(f?.expected_value)) for (const v of f.expected_value) push(v);
  else if (typeof f?.expected_value === "string") push(f.expected_value);
  // Dedupe while preserving order.
  return Array.from(new Set(out));
}

function normaliseSchema(raw: any): SchemaField[] {
  if (!Array.isArray(raw)) return [];
  const out: SchemaField[] = [];
  const seen = new Set<string>();
  for (const f of raw) {
    const fname = (f?.name ?? "").toString().trim();
    if (!fname || seen.has(fname)) continue;
    seen.add(fname);
    const description = (f?.description ?? "").toString().trim();
    const expected_values = coerceExpectedValues(f);
    out.push({
      name: fname,
      ...(description ? { description } : {}),
      ...(expected_values.length ? { expected_values } : {}),
    });
  }
  return out;
}
interface DatasetImage {
  id: string;
  name: string;
  image_url: string;
  thumb_url?: string;
}
interface DatasetDoc {
  _id?: ObjectId;
  name: string;
  schema: SchemaField[];
  images: DatasetImage[];
  created_at: Date;
  updated_at: Date;
}

async function loadDataset(db: Db, id: string) {
  try {
    return await db.collection("datasets").findOne({ _id: new ObjectId(id) });
  } catch {
    return null;
  }
}

function summary(d: any) {
  return {
    id: d._id.toString(),
    name: d.name,
    schema_count: d.schema?.length ?? 0,
    image_count: d.images?.length ?? 0,
    created_at: d.created_at,
    updated_at: d.updated_at,
  };
}

function fullView(d: any) {
  return {
    ...summary(d),
    schema: normaliseSchema(d.schema ?? []),
    images: d.images ?? [],
  };
}

function normForMatch(s: any): string {
  return String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Per-engine stats for a single run: # match / # miss / avg time / pricing
 *  breakdown. Only schema fields with at least one expected_values entry are
 *  evaluated. Cost is computed by summing each pricing component's
 *  metadata_key across all per-image results, then multiplying by the
 *  engine's declared unit price. */
function perEngineStats(run: any) {
  const engineIds: string[] = run.engine_ids ?? [];
  const schemaRaw: any[] = run.schema ?? [];
  // Read legacy single-string `expected_value` data here too so old runs work.
  const schema: { name: string; expected_norms: string[] }[] = schemaRaw.map((f) => ({
    name: f?.name,
    expected_norms: coerceExpectedValues(f).map(normForMatch).filter((v) => v !== ""),
  }));
  const images: any[] = run.images ?? [];
  const truthFields = schema.filter((f) => f.name && f.expected_norms.length > 0);

  return engineIds.map((eid) => {
    const engine = getEngine(eid);
    const components = engine?.pricing().components ?? [];
    const totals: Record<string, number> = {};
    for (const c of components) totals[c.metadata_key] = 0;

    let matches = 0;
    let misses = 0;
    let totalTime = 0;
    let timeSamples = 0;
    let errors = 0;
    let resultCount = 0;
    for (const img of images) {
      const r = run.results?.[eid]?.[img.id];
      if (!r) continue;
      resultCount++;
      if (r.error) errors++;
      if (typeof r.processing_time === "number") {
        totalTime += r.processing_time;
        timeSamples++;
      }
      for (const c of components) {
        const v = r.metadata?.[c.metadata_key];
        if (typeof v === "number" && Number.isFinite(v)) totals[c.metadata_key] += v;
      }
      for (const f of truthFields) {
        const actual = normForMatch(r.fields?.[f.name]);
        const hit = f.expected_norms.some((e) => actual.includes(e));
        if (hit) matches++; else misses++;
      }
    }

    const breakdown = components.map((c) => ({
      label: c.label,
      display_unit: c.display_unit,
      display_rate: c.display_rate,
      total_units: totals[c.metadata_key] ?? 0,
      total_cost_usd: (totals[c.metadata_key] ?? 0) * c.unit_price_usd,
    }));
    const total_cost_usd = breakdown.reduce((a, c) => a + c.total_cost_usd, 0);

    return {
      engine_id: eid,
      matches,
      misses,
      evaluated: matches + misses,
      errors,
      avg_time: timeSamples ? totalTime / timeSamples : 0,
      result_count: resultCount,
      total_cost_usd,
      pricing_breakdown: breakdown,
    };
  });
}

function latestRunSummary(run: any) {
  if (!run) return null;
  const engines = perEngineStats(run);
  const matches = engines.reduce((a, e) => a + e.matches, 0);
  const misses = engines.reduce((a, e) => a + e.misses, 0);
  return {
    id: run._id.toString(),
    status: run.status,
    engine_ids: run.engine_ids ?? [],
    rerunning_engines: run.rerunning_engines ?? [],
    image_count: (run.images ?? []).length,
    matches,
    misses,
    evaluated: matches + misses,
    done: run.done ?? 0,
    total: run.total ?? 0,
    completed_at: run.completed_at,
    created_at: run.created_at,
    per_engine: engines,
  };
}

async function latestRunFor(db: Db, datasetId: ObjectId) {
  return await db
    .collection("runs")
    .find({ dataset_id: datasetId })
    .sort({ created_at: -1 })
    .limit(1)
    .next();
}

router.get("/datasets", async (_req: Request, res: Response) => {
  try {
    const db = getDB();
    if (!db) return void res.json({ datasets: [] });
    const docs = await db.collection("datasets").find({}).sort({ created_at: -1 }).toArray();
    const runs = await db
      .collection("runs")
      .aggregate([
        { $match: { dataset_id: { $in: docs.map((d) => d._id) } } },
        { $sort: { created_at: -1 } },
        { $group: { _id: "$dataset_id", run: { $first: "$$ROOT" } } },
      ])
      .toArray();
    const runByDataset = new Map<string, any>(
      runs.map((r) => [r._id.toString(), r.run])
    );
    const datasets = docs.map((d) => ({
      ...summary(d),
      latest_run: latestRunSummary(runByDataset.get(d._id.toString())),
    }));
    res.json({ datasets });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/datasets/:id", async (req: Request, res: Response) => {
  try {
    const db = getDB();
    if (!db) return void res.status(503).json({ error: "Database not available" });
    const d = await loadDataset(db, req.params.id);
    if (!d) return void res.status(404).json({ error: "Not found" });
    const latest = await latestRunFor(db, d._id);
    res.json({ ...fullView(d), latest_run: latestRunSummary(latest) });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/datasets", async (req: Request, res: Response) => {
  try {
    const db = getDB();
    if (!db) return void res.status(503).json({ error: "Database not available" });
    const name = (req.body?.name ?? "").toString().trim();
    if (!name) return void res.status(400).json({ error: "name is required" });
    const schema = normaliseSchema(req.body?.schema);

    const now = new Date();
    const doc: DatasetDoc = {
      _id: new ObjectId(),
      name,
      schema,
      images: [],
      created_at: now,
      updated_at: now,
    };
    await db.collection("datasets").insertOne(doc as any);
    res.json(fullView(doc));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.put("/datasets/:id", async (req: Request, res: Response) => {
  try {
    const db = getDB();
    if (!db) return void res.status(503).json({ error: "Database not available" });
    const existing = await loadDataset(db, req.params.id);
    if (!existing) return void res.status(404).json({ error: "Not found" });

    const update: any = { updated_at: new Date() };
    if (typeof req.body?.name === "string" && req.body.name.trim())
      update.name = req.body.name.trim();
    if (Array.isArray(req.body?.schema)) {
      update.schema = normaliseSchema(req.body.schema);
    }
    await db.collection("datasets").updateOne({ _id: existing._id }, { $set: update });
    const refreshed = await db.collection("datasets").findOne({ _id: existing._id });
    res.json(fullView(refreshed));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/datasets/:id", async (req: Request, res: Response) => {
  try {
    const db = getDB();
    if (!db) return void res.status(503).json({ error: "Database not available" });
    const existing = await loadDataset(db, req.params.id);
    if (!existing) return void res.status(404).json({ error: "Not found" });
    await db.collection("datasets").deleteOne({ _id: existing._id });
    // Best-effort cleanup of image files.
    const images: DatasetImage[] = existing.images ?? [];
    await Promise.all(images.flatMap((i) => [deleteByUrl(i.image_url), deleteByUrl(i.thumb_url)]));
    // Also remove eventual runs for this dataset.
    await db.collection("runs").deleteMany({ dataset_id: existing._id });
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post(
  "/datasets/:id/images",
  upload.array("files", 30),
  async (req: Request, res: Response) => {
    try {
      const db = getDB();
      if (!db) return void res.status(503).json({ error: "Database not available" });
      const existing = await loadDataset(db, req.params.id);
      if (!existing) return void res.status(404).json({ error: "Dataset not found" });
      const files = (req.files as Express.Multer.File[]) ?? [];
      if (files.length === 0) return void res.status(400).json({ error: "No files uploaded" });

      const id = existing._id.toString();
      const added: DatasetImage[] = [];
      for (const f of files) {
        const uuid = randomUUID();
        const full = await sharp(f.buffer)
          .resize(4000, 4000, { fit: "inside", withoutEnlargement: true })
          .png()
          .toBuffer();
        const thumb = await sharp(full)
          .resize(320, 320, { fit: "inside", withoutEnlargement: true })
          .webp({ quality: 70 })
          .toBuffer();
        const [image_url, thumb_url] = await Promise.all([
          putObject(`datasets/${id}/${uuid}.png`, full, "image/png"),
          putObject(`datasets/${id}/${uuid}_thumb.webp`, thumb, "image/webp"),
        ]);
        added.push({ id: uuid, name: f.originalname || `${uuid}.png`, image_url, thumb_url });
      }
      await db.collection("datasets").updateOne(
        { _id: existing._id },
        { $push: { images: { $each: added } } as any, $set: { updated_at: new Date() } }
      );
      const refreshed = await db.collection("datasets").findOne({ _id: existing._id });
      res.json({ added, dataset: fullView(refreshed) });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  }
);

router.delete("/datasets/:id/images/:imageId", async (req: Request, res: Response) => {
  try {
    const db = getDB();
    if (!db) return void res.status(503).json({ error: "Database not available" });
    const existing = await loadDataset(db, req.params.id);
    if (!existing) return void res.status(404).json({ error: "Not found" });
    const images: DatasetImage[] = existing.images ?? [];
    const target = images.find((i) => i.id === req.params.imageId);
    if (!target) return void res.status(404).json({ error: "Image not found" });
    await db.collection("datasets").updateOne(
      { _id: existing._id },
      { $pull: { images: { id: req.params.imageId } } as any, $set: { updated_at: new Date() } }
    );
    await Promise.all([deleteByUrl(target.image_url), deleteByUrl(target.thumb_url)]);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
