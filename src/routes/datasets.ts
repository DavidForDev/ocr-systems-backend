import { Router, Request, Response } from "express";
import multer from "multer";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { ObjectId, Db } from "mongodb";
import { getDB } from "../db.js";
import { copyByUrl, deleteByUrl, putObject } from "../storage.js";

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

interface FieldSchemaItem {
  name: string;
  description?: string;
  requireAllValues?: boolean;
  default_value?: string[];
}
interface DatasetItem {
  id: string;
  name: string;
  image_url: string;
  thumb_url?: string;
  ground_truth: Record<string, string[]>;
}
interface DatasetBody {
  name: string;
  description?: string;
  field_schema: FieldSchemaItem[];
  items?: DatasetItem[];
}

function validateBody(body: any): { ok: true; body: DatasetBody } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "Invalid body" };
  const name = (body.name ?? "").toString().trim();
  if (!name) return { ok: false, error: "name is required" };
  const description = (body.description ?? "").toString();
  const field_schema = Array.isArray(body.field_schema) ? body.field_schema : null;
  if (!field_schema || field_schema.length === 0)
    return { ok: false, error: "field_schema must have at least one field" };

  const seen = new Set<string>();
  for (const f of field_schema) {
    const n = (f?.name ?? "").toString().trim();
    if (!n) return { ok: false, error: "every field needs a name" };
    if (seen.has(n)) return { ok: false, error: `duplicate field "${n}"` };
    seen.add(n);
  }
  const items = Array.isArray(body.items) ? body.items : [];
  return { ok: true, body: { name, description, field_schema, items } };
}

async function loadDataset(db: Db, id: string) {
  try {
    return await db.collection("datasets").findOne({ _id: new ObjectId(id) });
  } catch {
    return null;
  }
}

/** ── Routes ──────────────────────────────────────────────────── */

router.post("/datasets", async (req: Request, res: Response) => {
  try {
    const db = getDB();
    if (!db) return void res.status(503).json({ error: "Database not available" });
    const v = validateBody(req.body);
    if (!v.ok) return void res.status(400).json({ error: v.error });

    const now = new Date();
    const doc = {
      _id: new ObjectId(),
      slug: null,
      name: v.body.name,
      description: v.body.description ?? "",
      field_schema: v.body.field_schema,
      items: v.body.items ?? [],
      builtin: false,
      created_at: now,
      updated_at: now,
    };
    await db.collection("datasets").insertOne(doc as any);
    res.json({ id: doc._id.toString() });
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
    if (existing.builtin) return void res.status(403).json({ error: "Builtin dataset is read-only" });

    const v = validateBody(req.body);
    if (!v.ok) return void res.status(400).json({ error: v.error });

    // Garbage-collect images for items that were removed.
    const oldItems: DatasetItem[] = existing.items ?? [];
    const newItemIds = new Set(v.body.items?.map((i) => i.id));
    const removed = oldItems.filter((i) => !newItemIds.has(i.id));
    await Promise.all(removed.flatMap((i) => [deleteByUrl(i.image_url), deleteByUrl(i.thumb_url)]));

    await db.collection("datasets").updateOne(
      { _id: existing._id },
      {
        $set: {
          name: v.body.name,
          description: v.body.description ?? "",
          field_schema: v.body.field_schema,
          items: v.body.items ?? [],
          updated_at: new Date(),
        },
      }
    );
    res.json({ ok: true });
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
    if (existing.builtin) return void res.status(403).json({ error: "Builtin dataset is read-only" });

    await db.collection("datasets").deleteOne({ _id: existing._id });
    const items: DatasetItem[] = existing.items ?? [];
    await Promise.all(items.flatMap((i) => [deleteByUrl(i.image_url), deleteByUrl(i.thumb_url)]));
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/datasets/:id/clone", async (req: Request, res: Response) => {
  try {
    const db = getDB();
    if (!db) return void res.status(503).json({ error: "Database not available" });
    const src = await loadDataset(db, req.params.id);
    if (!src) return void res.status(404).json({ error: "Not found" });

    const newId = new ObjectId();
    const newIdStr = newId.toString();

    // Copy each item's images via the storage adapter (R2 CopyObject when both
    // sides are in R2, otherwise fetch + re-upload).
    const items: DatasetItem[] = await Promise.all(
      ((src.items ?? []) as DatasetItem[]).map(async (item) => {
        const uuid = randomUUID();
        const image_url = await copyByUrl(item.image_url, `datasets/${newIdStr}/${uuid}.png`);
        const thumb_url = await copyByUrl(item.thumb_url, `datasets/${newIdStr}/${uuid}_thumb.webp`);
        return {
          ...item,
          id: uuid,
          image_url: image_url ?? "",
          thumb_url: thumb_url ?? undefined,
        };
      })
    );

    const now = new Date();
    const requestedName: string | undefined = req.body?.name;
    const cloneName = (requestedName ?? `${src.name} (copy)`).toString().trim() || `${src.name} (copy)`;

    const doc = {
      _id: newId,
      name: cloneName,
      description: src.description ?? "",
      field_schema: src.field_schema ?? [],
      items,
      builtin: false,
      cloned_from: src._id,
      created_at: now,
      updated_at: now,
    };
    await db.collection("datasets").insertOne(doc as any);
    res.json({ id: newId.toString() });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post(
  "/datasets/:id/images",
  upload.single("file"),
  async (req: Request, res: Response) => {
    try {
      const db = getDB();
      if (!db) return void res.status(503).json({ error: "Database not available" });
      if (!req.file) return void res.status(400).json({ error: "No file uploaded" });

      const ds = await loadDataset(db, req.params.id);
      if (!ds) return void res.status(404).json({ error: "Dataset not found" });
      if (ds.builtin) return void res.status(403).json({ error: "Builtin dataset is read-only" });

      const id = req.params.id;
      const uuid = randomUUID();
      const full = await sharp(req.file.buffer)
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

      res.json({
        image_url,
        thumb_url,
        original_name: req.file.originalname,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  }
);

export default router;
