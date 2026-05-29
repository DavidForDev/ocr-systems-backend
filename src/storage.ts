/**
 * Image storage adapter — Cloudflare R2 when configured, local ./uploads otherwise.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const LOCAL_UPLOADS_DIR = path.resolve(__dirname, "../uploads");

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

if (!r2 && [accountId, bucket, accessKeyId, secretAccessKey, publicBase].some((v) => !!v)) {
  const missing = { R2_ACCOUNT_ID: accountId, R2_BUCKET: bucket, R2_ACCESS_KEY_ID: accessKeyId, R2_SECRET_ACCESS_KEY: secretAccessKey, R2_PUBLIC_BASE_URL: publicBase };
  const m = Object.entries(missing).filter(([, v]) => !v).map(([k]) => k);
  console.warn(`[storage] R2 partially configured — using LOCAL. Missing: ${m.join(", ")}`);
}

export async function putObject(key: string, body: Buffer, contentType: string): Promise<string> {
  if (!r2) {
    const filePath = path.join(LOCAL_UPLOADS_DIR, key);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, body);
    return `/uploads/${key}`;
  }
  await r2.client.send(new PutObjectCommand({ Bucket: r2.bucket, Key: key, Body: body, ContentType: contentType }));
  return `${r2.publicBase}/${key}`;
}

/** Reject anything that, once normalised, escapes its parent directory or
 *  contains absolute paths / traversal segments. Storage URLs are always
 *  server-generated UUID paths, so any escape attempt is a bug or attack. */
function safeKey(raw: string): string | null {
  const trimmed = raw.replace(/^\/+/, "");
  if (!trimmed) return null;
  const normalised = path.posix.normalize(trimmed);
  if (
    normalised.startsWith("..") ||
    normalised.includes("/../") ||
    normalised.endsWith("/..") ||
    path.isAbsolute(normalised)
  ) {
    return null;
  }
  return normalised;
}

export function keyFromUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  let raw: string | null = null;
  if (r2 && url.startsWith(r2.publicBase + "/")) {
    raw = decodeURIComponent(url.slice(r2.publicBase.length + 1));
  } else if (url.startsWith("/uploads/")) {
    raw = decodeURIComponent(url.slice("/uploads/".length));
  }
  return raw == null ? null : safeKey(raw);
}

export async function deleteByUrl(url: string | undefined | null): Promise<void> {
  const key = keyFromUrl(url);
  if (!key) return;
  if (!r2) {
    const target = path.resolve(LOCAL_UPLOADS_DIR, key);
    // Defence-in-depth: even after safeKey, refuse to act outside LOCAL_UPLOADS_DIR.
    if (!target.startsWith(LOCAL_UPLOADS_DIR + path.sep) && target !== LOCAL_UPLOADS_DIR) {
      console.warn(`[storage] refused delete outside uploads dir: ${target}`);
      return;
    }
    await fs.rm(target, { force: true });
    return;
  }
  try {
    await r2.client.send(new DeleteObjectCommand({ Bucket: r2.bucket, Key: key }));
  } catch {
    /* best effort */
  }
}

/** Fetch raw bytes from a public URL (R2 or local). Used by engines that need image bytes. */
export async function getBytesFromUrl(url: string): Promise<Buffer> {
  if (/^https?:\/\//.test(url)) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Fetch ${url} → HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }
  if (url.startsWith("/uploads/")) {
    const key = safeKey(decodeURIComponent(url.slice("/uploads/".length)));
    if (!key) throw new Error(`Refused unsafe upload path: ${url}`);
    const target = path.resolve(LOCAL_UPLOADS_DIR, key);
    if (!target.startsWith(LOCAL_UPLOADS_DIR + path.sep) && target !== LOCAL_UPLOADS_DIR) {
      throw new Error(`Refused path outside uploads dir: ${url}`);
    }
    return fs.readFile(target);
  }
  throw new Error(`Unsupported url: ${url}`);
}
