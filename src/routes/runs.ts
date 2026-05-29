import { Router, Request, Response } from "express";
import { ObjectId, Db } from "mongodb";
import { getDB } from "../db.js";
import { getAllEngines, getEngine } from "../engines/index.js";
import { getBytesFromUrl } from "../storage.js";

const router = Router();

router.get("/engines", (_req: Request, res: Response) => {
  res.json({ engines: getAllEngines().map((e) => e.info()) });
});

/** Kick off a run on a dataset (selected engines × all images). Returns
 *  immediately; the result accumulates in Mongo. Frontend polls GET /runs/:id. */
router.post("/datasets/:id/run", async (req: Request, res: Response) => {
  try {
    const db = getDB();
    if (!db) return void res.status(503).json({ error: "Database not available" });

    let datasetId: ObjectId;
    try {
      datasetId = new ObjectId(req.params.id);
    } catch {
      return void res.status(400).json({ error: "Invalid dataset id" });
    }
    const dataset = await db.collection("datasets").findOne({ _id: datasetId });
    if (!dataset) return void res.status(404).json({ error: "Dataset not found" });

    const engineIds: string[] = Array.isArray(req.body?.engine_ids)
      ? req.body.engine_ids
      : getAllEngines().map((e) => e.id);
    const selected = engineIds.map(getEngine).filter((e): e is NonNullable<typeof e> => !!e);
    if (selected.length === 0) return void res.status(400).json({ error: "No valid engines" });

    const images: any[] = dataset.images ?? [];
    const schema: { name: string }[] = dataset.schema ?? [];
    if (schema.length === 0)
      return void res.status(400).json({ error: "Dataset has no schema fields" });
    if (images.length === 0)
      return void res.status(400).json({ error: "Dataset has no images" });

    const runId = new ObjectId();
    const total = selected.length * images.length;
    const initial = {
      _id: runId,
      dataset_id: datasetId,
      dataset_name: dataset.name,
      engine_ids: selected.map((e) => e.id),
      schema,
      images: images.map((i) => ({ id: i.id, name: i.name, image_url: i.image_url, thumb_url: i.thumb_url })),
      total,
      done: 0,
      status: "running",
      results: {} as Record<string, any>, // [engine_id][image_id] -> { fields, ... }
      created_at: new Date(),
      completed_at: null as Date | null,
      error: null as string | null,
    };
    await db.collection("runs").insertOne(initial as any);

    // Fire-and-forget.
    runInBackground(db, runId, selected, images, schema).catch(async (err) => {
      console.error("[run] background failed", err);
      await db.collection("runs").updateOne(
        { _id: runId },
        { $set: { status: "error", error: err?.message ?? String(err), completed_at: new Date() } }
      );
    });

    res.json({ id: runId.toString(), status: "running" });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/runs/:id", async (req: Request, res: Response) => {
  try {
    const db = getDB();
    if (!db) return void res.status(503).json({ error: "Database not available" });
    let oid: ObjectId;
    try { oid = new ObjectId(req.params.id); } catch { return void res.status(400).json({ error: "Invalid id" }); }
    const doc = await db.collection("runs").findOne({ _id: oid });
    if (!doc) return void res.status(404).json({ error: "Not found" });
    res.json({ id: doc._id.toString(), ...doc, _id: undefined });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** Re-run a single engine against all images of an existing run. Updates the
 *  run in place so the other engines' results are preserved. */
router.post("/runs/:runId/engines/:engineId/rerun", async (req: Request, res: Response) => {
  try {
    const db = getDB();
    if (!db) return void res.status(503).json({ error: "Database not available" });
    let runOid: ObjectId;
    try { runOid = new ObjectId(req.params.runId); } catch { return void res.status(400).json({ error: "Invalid run id" }); }
    const engineId = req.params.engineId;
    const engine = getEngine(engineId);
    if (!engine) return void res.status(404).json({ error: "Engine not registered" });

    const run = await db.collection("runs").findOne({ _id: runOid });
    if (!run) return void res.status(404).json({ error: "Run not found" });
    const images: any[] = run.images ?? [];
    const schema: { name: string }[] = run.schema ?? [];
    if (!images.length) return void res.status(400).json({ error: "Run has no images" });
    if (!schema.length) return void res.status(400).json({ error: "Run has no schema" });

    const engineIds: string[] = Array.isArray(run.engine_ids) ? run.engine_ids : [];
    const nextEngineIds = engineIds.includes(engineId) ? engineIds : [...engineIds, engineId];

    await db.collection("runs").updateOne(
      { _id: runOid },
      {
        $set: {
          [`results.${engineId}`]: {},
          status: "running",
          completed_at: null,
          error: null,
          engine_ids: nextEngineIds,
        },
        $addToSet: { rerunning_engines: engineId } as any,
      }
    );

    rerunEngineInBackground(db, runOid, engine, images, schema).catch(async (err) => {
      console.error("[run] rerun engine failed", err);
      await db.collection("runs").updateOne(
        { _id: runOid },
        {
          $set: { error: err?.message ?? String(err) },
          $pull: { rerunning_engines: engineId } as any,
        }
      );
      await finalizeIfIdle(db, runOid);
    });

    res.json({ ok: true, run_id: runOid.toString() });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** Latest run for a dataset (so reloading the page shows last results). */
router.get("/datasets/:id/latest-run", async (req: Request, res: Response) => {
  try {
    const db = getDB();
    if (!db) return void res.status(503).json({ error: "Database not available" });
    let datasetId: ObjectId;
    try { datasetId = new ObjectId(req.params.id); } catch { return void res.status(400).json({ error: "Invalid id" }); }
    const doc = await db.collection("runs").find({ dataset_id: datasetId }).sort({ created_at: -1 }).limit(1).next();
    if (!doc) return void res.json(null);
    res.json({ id: doc._id.toString(), ...doc, _id: undefined });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

async function runInBackground(
  db: Db,
  runId: ObjectId,
  engines: ReturnType<typeof getAllEngines>,
  images: any[],
  schema: { name: string }[]
) {
  // Process per-image in parallel across engines; throttle images in small
  // batches to keep memory + provider rate limits sane.
  const BATCH = 3;
  let done = 0;

  for (let i = 0; i < images.length; i += BATCH) {
    const slice = images.slice(i, i + BATCH);
    await Promise.all(
      slice.map(async (img) => {
        const bytes = await safeBytes(img.image_url);
        await Promise.all(
          engines.map(async (eng) => {
            const result = bytes
              ? await safeExtract(eng, bytes, schema)
              : {
                  fields: Object.fromEntries(schema.map((f) => [f.name, null])),
                  ocr_text: null,
                  processing_time: 0,
                  error: "Could not load image bytes",
                  metadata: {},
                };
            await db.collection("runs").updateOne(
              { _id: runId },
              {
                $set: {
                  [`results.${eng.id}.${img.id}`]: result,
                },
                $inc: { done: 1 },
              }
            );
            done++;
          })
        );
      })
    );
  }
  void done;

  await db.collection("runs").updateOne(
    { _id: runId },
    { $set: { status: "complete", completed_at: new Date() } }
  );
}

async function rerunEngineInBackground(
  db: Db,
  runId: ObjectId,
  engine: NonNullable<ReturnType<typeof getEngine>>,
  images: any[],
  schema: { name: string }[]
) {
  const BATCH = 3;
  for (let i = 0; i < images.length; i += BATCH) {
    const slice = images.slice(i, i + BATCH);
    await Promise.all(
      slice.map(async (img) => {
        const bytes = await safeBytes(img.image_url);
        const result = bytes
          ? await safeExtract(engine, bytes, schema)
          : {
              fields: Object.fromEntries(schema.map((f) => [f.name, null])),
              ocr_text: null,
              processing_time: 0,
              error: "Could not load image bytes",
              metadata: {},
            };
        await db.collection("runs").updateOne(
          { _id: runId },
          { $set: { [`results.${engine.id}.${img.id}`]: result } }
        );
      })
    );
  }
  await db.collection("runs").updateOne(
    { _id: runId },
    { $pull: { rerunning_engines: engine.id } as any }
  );
  await finalizeIfIdle(db, runId);
}

/** If no engine is currently being re-run, flip the run back to "complete". */
async function finalizeIfIdle(db: Db, runId: ObjectId) {
  const fresh = await db.collection("runs").findOne({ _id: runId });
  if (!fresh) return;
  const rerunning: string[] = fresh.rerunning_engines ?? [];
  if (rerunning.length === 0 && fresh.status === "running") {
    await db
      .collection("runs")
      .updateOne(
        { _id: runId },
        { $set: { status: "complete", completed_at: new Date() } }
      );
  }
}

async function safeBytes(url: string): Promise<Buffer | null> {
  try {
    return await getBytesFromUrl(url);
  } catch {
    return null;
  }
}

async function safeExtract(eng: any, bytes: Buffer, schema: { name: string }[]) {
  try {
    return await eng.extract(bytes, schema);
  } catch (e: any) {
    return {
      fields: Object.fromEntries(schema.map((f) => [f.name, null])),
      ocr_text: null,
      processing_time: 0,
      error: e?.message ?? "Engine error",
      metadata: {},
    };
  }
}

export default router;
