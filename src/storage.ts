/**
 * Image storage adapter.
 *
 * Modes:
 *  - "r2"    — Cloudflare R2 (S3-compatible) when all R2_* env vars are set.
 *  - "local" — writes to ./uploads on disk and serves via /uploads (dev/Railway-without-R2).
 *
 * All run images, dataset items, and seed images flow through this adapter, so
 * the calling code never has to know where bytes actually live.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const LOCAL_UPLOADS_DIR = path.resolve(__dirname, "../uploads");
const SEED_DIR = path.resolve(__dirname, "../seed");

const accountId = process.env.R2_ACCOUNT_ID?.trim();
const bucket = process.env.R2_BUCKET?.trim();
const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim();
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim();
const publicBase = (process.env.R2_PUBLIC_BASE_URL || "").trim().replace(/\/$/, "");

const r2 =
  accountId && bucket && accessKeyId && secretAccessKey && publicBase
    ? {
        client: new S3Client({
          region: "auto",
          endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
          credentials: { accessKeyId, secretAccessKey },
        }),
        bucket,
        publicBase,
      }
    : null;

export const storageMode: "r2" | "local" = r2 ? "r2" : "local";

// If the user *tried* to configure R2 but missed something, say which keys are
// missing — silent fallback to local is exactly the bug they reported.
const r2Vars = { R2_ACCOUNT_ID: accountId, R2_BUCKET: bucket, R2_ACCESS_KEY_ID: accessKeyId, R2_SECRET_ACCESS_KEY: secretAccessKey, R2_PUBLIC_BASE_URL: publicBase };
const anyR2Set = Object.values(r2Vars).some((v) => !!v);
if (!r2 && anyR2Set) {
  const missing = Object.entries(r2Vars).filter(([, v]) => !v).map(([k]) => k);
  console.warn(`[storage] R2 partially configured — falling back to LOCAL. Missing: ${missing.join(", ")}`);
}

/** Upload a buffer under `key` and return its public URL. */
export async function putObject(
  key: string,
  body: Buffer,
  contentType: string
): Promise<string> {
  if (!r2) {
    const filePath = path.join(LOCAL_UPLOADS_DIR, key);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, body);
    return `/uploads/${key}`;
  }
  await r2.client.send(
    new PutObjectCommand({
      Bucket: r2.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );
  return `${r2.publicBase}/${key}`;
}

/** Map a public URL back to its storage key, if we own it. */
export function keyFromUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  if (r2 && url.startsWith(r2.publicBase + "/")) {
    return decodeURIComponent(url.slice(r2.publicBase.length + 1));
  }
  if (url.startsWith("/uploads/")) return url.slice("/uploads/".length);
  return null;
}

export async function deleteByUrl(url: string | undefined | null): Promise<void> {
  const key = keyFromUrl(url);
  if (!key) return;
  if (!r2) {
    await fs.rm(path.join(LOCAL_UPLOADS_DIR, key), { force: true });
    return;
  }
  try {
    await r2.client.send(new DeleteObjectCommand({ Bucket: r2.bucket, Key: key }));
  } catch {
    /* best effort */
  }
}

/**
 * Copy an existing image (any public URL we can resolve) to a new key.
 * Used by dataset clone. Returns the new public URL, or undefined on failure.
 */
export async function copyByUrl(
  srcUrl: string | undefined | null,
  destKey: string
): Promise<string | undefined> {
  if (!srcUrl) return undefined;
  const srcKey = keyFromUrl(srcUrl);

  if (srcKey && r2) {
    try {
      await r2.client.send(
        new CopyObjectCommand({
          Bucket: r2.bucket,
          Key: destKey,
          CopySource: `${r2.bucket}/${encodeURIComponent(srcKey)}`,
        })
      );
      return `${r2.publicBase}/${destKey}`;
    } catch {
      return undefined;
    }
  }

  if (srcKey && !r2) {
    const absSrc = path.join(LOCAL_UPLOADS_DIR, srcKey);
    const absDest = path.join(LOCAL_UPLOADS_DIR, destKey);
    try {
      await fs.mkdir(path.dirname(absDest), { recursive: true });
      await fs.copyFile(absSrc, absDest);
      return `/uploads/${destKey}`;
    } catch {
      return undefined;
    }
  }

  // External URL (or /seed/) — fetch then re-upload.
  try {
    const buf = await getBytesFromUrl(srcUrl);
    const ct =
      destKey.endsWith(".webp")
        ? "image/webp"
        : destKey.endsWith(".jpg") || destKey.endsWith(".jpeg")
        ? "image/jpeg"
        : "image/png";
    return await putObject(destKey, buf, ct);
  } catch {
    return undefined;
  }
}

/** Fetch the raw bytes behind any public URL we know how to resolve. */
export async function getBytesFromUrl(url: string): Promise<Buffer> {
  if (!url) throw new Error("Empty url");
  if (/^https?:\/\//.test(url)) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Fetch ${url} → HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  if (url.startsWith("/seed/")) {
    return fs.readFile(path.join(SEED_DIR, url.slice("/seed/".length)));
  }
  if (url.startsWith("/uploads/")) {
    return fs.readFile(path.join(LOCAL_UPLOADS_DIR, url.slice("/uploads/".length)));
  }
  throw new Error(`Unsupported image url: ${url}`);
}
