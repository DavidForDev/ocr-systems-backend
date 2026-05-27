import { Router, Request, Response } from "express";
import multer from "multer";
import sharp from "sharp";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ObjectId } from "mongodb";
import { engines, getEngine, getAllEngines } from "../engines/index.js";
import { getDB } from "../db.js";
import { extractFields } from "../utils/schemaExtractor.js";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// uploads/ lives at the backend root (../../uploads from src/routes).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const UPLOADS_DIR = path.resolve(__dirname, "../../uploads");

async function prepareImage(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer)
    .resize(4000, 4000, { fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();
}

/**
 * Persist the run's image to disk so history can show which image was used.
 * Stores a full-size PNG and a small WebP thumbnail; returns their public URLs.
 */
async function saveRunImage(
  id: string,
  fullBuffer: Buffer
): Promise<{ image_url: string; thumb_url: string }> {
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
  const fullName = `${id}.png`;
  const thumbName = `${id}_thumb.webp`;

  const thumb = await sharp(fullBuffer)
    .resize(320, 320, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 70 })
    .toBuffer();

  await Promise.all([
    fs.writeFile(path.join(UPLOADS_DIR, fullName), fullBuffer),
    fs.writeFile(path.join(UPLOADS_DIR, thumbName), thumb),
  ]);

  return { image_url: `/uploads/${fullName}`, thumb_url: `/uploads/${thumbName}` };
}

async function deleteRunImage(run: { image_url?: string | null; thumb_url?: string | null }) {
  const names = [run.image_url, run.thumb_url]
    .filter((u): u is string => !!u)
    .map((u) => path.basename(u));
  await Promise.all(
    names.map((n) => fs.rm(path.join(UPLOADS_DIR, n), { force: true }))
  );
}

router.get("/engines", (_req: Request, res: Response) => {
  const list = getAllEngines().map((e) => e.info());
  res.json({ engines: list, count: list.length });
});

router.post("/ocr", upload.single("file"), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }

    const engineId = req.body.engine_id;
    const prompt = req.body.prompt || undefined;
    const fieldsRaw = req.body.fields;

    const engine = getEngine(engineId);
    if (!engine) {
      res.status(400).json({ error: `Unknown engine: ${engineId}` });
      return;
    }

    const imageBuffer = await prepareImage(req.file.buffer);
    const result = await engine.recognize(imageBuffer, prompt);

    if (fieldsRaw && result.text) {
      const fields = JSON.parse(fieldsRaw);
      result.fields = await extractFields(result.text, fields);
    }

    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/ocr/compare", upload.single("file"), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }

    const prompt = req.body.prompt || undefined;
    const fieldsRaw = req.body.fields;
    const engineIdsRaw = req.body.engine_ids;

    let selectedEngines = getAllEngines();
    if (engineIdsRaw) {
      const ids: string[] = JSON.parse(engineIdsRaw);
      selectedEngines = ids
        .map((id) => getEngine(id))
        .filter((e): e is NonNullable<typeof e> => e != null);
    }

    if (selectedEngines.length === 0) {
      res.status(400).json({ error: "No valid engines selected" });
      return;
    }

    const imageBuffer = await prepareImage(req.file.buffer);

    const fieldList: string[] | null = fieldsRaw ? JSON.parse(fieldsRaw) : null;

    const results = await Promise.all(
      selectedEngines.map(async (engine) => {
        const result = await engine.recognize(imageBuffer, prompt);
        if (fieldList && fieldList.length > 0 && result.text) {
          result.fields = await extractFields(result.text, fieldList);
        }
        return result;
      })
    );

    const db = getDB();
    let runId: string | null = null;
    let imageUrls = { image_url: null as string | null, thumb_url: null as string | null };

    if (db) {
      // Allocate the id up front so the saved image filenames match the run.
      const oid = new ObjectId();
      runId = oid.toString();
      try {
        imageUrls = await saveRunImage(runId, imageBuffer);
      } catch (imgErr) {
        console.warn("Failed to save run image:", (imgErr as Error).message);
      }

      const doc = {
        _id: oid,
        filename: req.file.originalname,
        engine_ids: selectedEngines.map((e) => e.id),
        prompt: prompt || null,
        fields: fieldList,
        results,
        image_url: imageUrls.image_url,
        thumb_url: imageUrls.thumb_url,
        created_at: new Date(),
      };
      await db.collection("runs").insertOne(doc);
    }

    res.json({ run_id: runId, results, ...imageUrls });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/results", async (_req: Request, res: Response) => {
  try {
    const limit = parseInt((_req.query.limit as string) || "50", 10);
    const skip = parseInt((_req.query.skip as string) || "0", 10);

    const db = getDB();
    if (!db) {
      res.json({ runs: [], total: 0, limit, skip });
      return;
    }

    const total = await db.collection("runs").countDocuments();
    const runs = await db
      .collection("runs")
      .find({})
      .sort({ created_at: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    const mapped = runs.map((r) => ({
      id: r._id.toString(),
      filename: r.filename,
      engine_ids: r.engine_ids,
      prompt: r.prompt,
      fields: r.fields ?? null,
      results: r.results,
      image_url: r.image_url ?? null,
      thumb_url: r.thumb_url ?? null,
      created_at: r.created_at,
    }));

    res.json({ runs: mapped, total, limit, skip });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/results/:id", async (req: Request, res: Response) => {
  try {
    const db = getDB();
    if (!db) {
      res.status(404).json({ error: "Database not available" });
      return;
    }

    let oid: ObjectId;
    try {
      oid = new ObjectId(req.params.id);
    } catch {
      res.status(400).json({ error: "Invalid ID format" });
      return;
    }

    const run = await db.collection("runs").findOne({ _id: oid });
    if (!run) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    res.json({
      id: run._id.toString(),
      filename: run.filename,
      engine_ids: run.engine_ids,
      prompt: run.prompt,
      fields: run.fields ?? null,
      results: run.results,
      image_url: run.image_url ?? null,
      thumb_url: run.thumb_url ?? null,
      created_at: run.created_at,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/results/:id", async (req: Request, res: Response) => {
  try {
    const db = getDB();
    if (!db) {
      res.status(404).json({ error: "Database not available" });
      return;
    }

    let oid: ObjectId;
    try {
      oid = new ObjectId(req.params.id);
    } catch {
      res.status(400).json({ error: "Invalid ID format" });
      return;
    }

    const run = await db.collection("runs").findOne({ _id: oid });
    if (!run) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    await db.collection("runs").deleteOne({ _id: oid });
    await deleteRunImage({ image_url: run.image_url, thumb_url: run.thumb_url }).catch(() => {});

    res.json({ deleted: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
