import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { Db, ObjectId } from "mongodb";
import { putObject, storageMode } from "../storage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_ROOT = path.resolve(__dirname, "../../seed/insurance-medical");

export interface DatasetFieldSchema {
  name: string;
  description?: string;
  requireAllValues?: boolean;
}

export interface DatasetItem {
  id: string;
  name: string;
  image_url: string;
  thumb_url?: string;
  ground_truth: Record<string, string[]>;
}

export interface Dataset {
  _id?: ObjectId;
  slug: string;
  name: string;
  description: string;
  field_schema: DatasetFieldSchema[];
  items: DatasetItem[];
  builtin?: boolean;
  created_at: Date;
}

interface RawField {
  name: string;
  value: string[];
  description?: string;
  requireAllValues?: boolean;
}
interface RawMetadata {
  image: string;
  fields: RawField[];
}

const SLUG = "insurance-medical";

/**
 * Seed the built-in "Insurance Medical" dataset.
 *
 * In `r2` storage mode every image is uploaded to the bucket and the dataset
 * stores R2 URLs. In `local` mode we fall back to `/seed/...` paths served by
 * express.static (dev only). Idempotent by default; pass { force: true } from
 * the CLI script to delete and re-insert (and re-upload).
 */
export async function seedInsuranceMedical(
  db: Db,
  options: { force?: boolean } = {}
): Promise<void> {
  const existing = await db.collection("datasets").findOne({ slug: SLUG });
  if (existing && !options.force) return;
  if (existing && options.force) {
    await db.collection("datasets").deleteOne({ _id: existing._id });
    console.log(`[seed] removed existing "${SLUG}" — re-uploading`);
  }

  const imagesDir = path.join(SEED_ROOT, "images");
  const metaDir = path.join(SEED_ROOT, "metadata");

  if (!fs.existsSync(imagesDir) || !fs.existsSync(metaDir)) {
    console.warn("[seed] insurance-medical seed dir not found; skipping");
    return;
  }

  const imageByBase = new Map<string, string>();
  for (const file of fs.readdirSync(imagesDir)) {
    if (file.startsWith(".")) continue;
    imageByBase.set(path.parse(file).name, file);
  }

  const metaFiles = fs.readdirSync(metaDir).filter((f) => f.endsWith(".json")).sort();
  if (metaFiles.length === 0) return;

  const firstMeta: RawMetadata = JSON.parse(
    fs.readFileSync(path.join(metaDir, metaFiles[0]), "utf8")
  );
  const field_schema: DatasetFieldSchema[] = firstMeta.fields.map((f) => ({
    name: f.name,
    description: f.description,
    requireAllValues: f.requireAllValues,
  }));

  const items: DatasetItem[] = [];
  for (const mf of metaFiles) {
    const base = path.parse(mf).name;
    const imageFile = imageByBase.get(base);
    if (!imageFile) continue;
    const meta: RawMetadata = JSON.parse(fs.readFileSync(path.join(metaDir, mf), "utf8"));
    const ground_truth: Record<string, string[]> = {};
    for (const f of meta.fields) ground_truth[f.name] = f.value;

    let image_url: string;
    let thumb_url: string | undefined;

    if (storageMode === "r2") {
      const raw = fs.readFileSync(path.join(imagesDir, imageFile));
      const full = await sharp(raw)
        .resize(4000, 4000, { fit: "inside", withoutEnlargement: true })
        .png()
        .toBuffer();
      const thumb = await sharp(full)
        .resize(320, 320, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: 70 })
        .toBuffer();
      [image_url, thumb_url] = await Promise.all([
        putObject(`seed/insurance-medical/${base}.png`, full, "image/png"),
        putObject(`seed/insurance-medical/${base}_thumb.webp`, thumb, "image/webp"),
      ]);
    } else {
      image_url = `/seed/insurance-medical/images/${imageFile}`;
      thumb_url = undefined;
    }

    items.push({ id: base, name: imageFile, image_url, thumb_url, ground_truth });
  }

  const dataset: Dataset = {
    slug: SLUG,
    name: "Insurance Medical (Georgian)",
    description:
      "9 hand-labeled Georgian medical / insurance forms with field-level ground truth. " +
      "Used to benchmark OCR engines and the field extractor.",
    field_schema,
    items,
    builtin: true,
    created_at: new Date(),
  };

  await db.collection("datasets").insertOne(dataset as any);
  console.log(
    `[seed] Inserted dataset "${SLUG}" with ${items.length} items (storage: ${storageMode})`
  );
}
