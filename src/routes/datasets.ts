import { Router, Request, Response } from "express";
import multer from "multer";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ObjectId, Db } from "mongodb";
import { getDB } from "../db.js";
import { UPLOADS_DIR } from "./ocr.js";

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const DATASETS_DIR = path.join(UPLOADS_DIR, "datasets");

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

/** ── Helpers ─────────────────────────────────────────────────── */

async function ensureDatasetDir(id: string): Promise<string> {
  const dir = path.join(DATASETS_DIR, id);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function removeDatasetDir(id: string) {
  await fs.rm(path.join(DATASETS_DIR, id), { recursive: true, force: true });
}

async function removeFileFromUrl(u: string | undefined | null) {
  if (!u) return;
  // Only touch files under /uploads/...
  if (!u.startsWith("/uploads/")) return;
  const rel = u.replace(/^\/uploads\//, "");
  await fs.rm(path.join(UPLOADS_DIR, rel), { force: true });
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
    await Promise.all(removed.flatMap((i) => [removeFileFromUrl(i.image_url), removeFileFromUrl(i.thumb_url)]));

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
    await removeDatasetDir(existing._id.toString()).catch(() => {});
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
    const newDir = await ensureDatasetDir(newId.toString());

    // Copy images for each item (best-effort).
    const items: DatasetItem[] = await Promise.all(
      ((src.items ?? []) as DatasetItem[]).map(async (item) => {
        const copyUrl = async (u: string | undefined | null): Promise<string | undefined> => {
          if (!u) return undefined;
          // Source can be /seed/... (builtin) or /uploads/datasets/<srcId>/...
          let absSrc: string | null = null;
          if (u.startsWith("/seed/")) {
            // Look up real seed root (sibling of dist), same as index.ts.
            const seedRoot = path.resolve(UPLOADS_DIR, "..", "seed");
            absSrc = path.join(seedRoot, u.replace(/^\/seed\//, ""));
          } else if (u.startsWith("/uploads/")) {
            absSrc = path.join(UPLOADS_DIR, u.replace(/^\/uploads\//, ""));
          }
          if (!absSrc) return undefined;
          const ext = path.extname(absSrc) || ".png";
          const destName = `${randomUUID()}${ext}`;
          const absDest = path.join(newDir, destName);
          try {
            await fs.copyFile(absSrc, absDest);
          } catch {
            return undefined;
          }
          return `/uploads/datasets/${newId.toString()}/${destName}`;
        };
        const image_url = await copyUrl(item.image_url);
        const thumb_url = await copyUrl(item.thumb_url);
        return {
          ...item,
          id: randomUUID(),
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
      const dir = await ensureDatasetDir(id);
      const uuid = randomUUID();
      const full = await sharp(req.file.buffer)
        .resize(4000, 4000, { fit: "inside", withoutEnlargement: true })
        .png()
        .toBuffer();
      const thumb = await sharp(full)
        .resize(320, 320, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: 70 })
        .toBuffer();

      await Promise.all([
        fs.writeFile(path.join(dir, `${uuid}.png`), full),
        fs.writeFile(path.join(dir, `${uuid}_thumb.webp`), thumb),
      ]);

      res.json({
        image_url: `/uploads/datasets/${id}/${uuid}.png`,
        thumb_url: `/uploads/datasets/${id}/${uuid}_thumb.webp`,
        original_name: req.file.originalname,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  }
);

export default router;
