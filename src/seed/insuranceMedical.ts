import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Db, ObjectId } from "mongodb";

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

/**
 * Seed the built-in "Insurance Medical" dataset on first boot. Idempotent —
 * checks for the slug before inserting.
 */
export async function seedInsuranceMedical(db: Db): Promise<void> {
  const slug = "insurance-medical";
  const existing = await db.collection("datasets").findOne({ slug });
  if (existing) return;

  const imagesDir = path.join(SEED_ROOT, "images");
  const metaDir = path.join(SEED_ROOT, "metadata");

  if (!fs.existsSync(imagesDir) || !fs.existsSync(metaDir)) {
    console.warn("[seed] insurance-medical seed dir not found; skipping");
    return;
  }

  // Pair metadata <-> image by basename.
  const imageByBase = new Map<string, string>();
  for (const file of fs.readdirSync(imagesDir)) {
    if (file.startsWith(".")) continue;
    imageByBase.set(path.parse(file).name, file);
  }

  const metaFiles = fs
    .readdirSync(metaDir)
    .filter((f) => f.endsWith(".json"))
    .sort();

  if (metaFiles.length === 0) return;

  // Use the first metadata as the canonical field schema.
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
    items.push({
      id: base,
      name: imageFile,
      image_url: `/seed/insurance-medical/images/${imageFile}`,
      ground_truth,
    });
  }

  const dataset: Dataset = {
    slug,
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
  console.log(`[seed] Inserted dataset "${slug}" with ${items.length} items`);
}
