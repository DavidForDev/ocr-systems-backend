import "dotenv/config";
import express from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectDB } from "./db.js";
import ocrRouter from "./routes/ocr.js";
import evalsRouter from "./routes/evals.js";
import datasetsRouter from "./routes/datasets.js";
import { seedInsuranceMedical } from "./seed/insuranceMedical.js";
import { LOCAL_UPLOADS_DIR, storageMode } from "./storage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_DIR = path.resolve(__dirname, "../seed");

const app = express();
const PORT = parseInt(process.env.PORT || "8000", 10);

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Local fallback: when R2 isn't configured (dev), serve uploaded images from disk.
if (storageMode === "local") {
  fs.mkdirSync(LOCAL_UPLOADS_DIR, { recursive: true });
  app.use(
    "/uploads",
    express.static(LOCAL_UPLOADS_DIR, { maxAge: "7d", immutable: true })
  );
}

// Seed images shipped inside the container — only served when R2 isn't used,
// since with R2 the seeder uploads them and dataset URLs point at the bucket.
if (storageMode === "local") {
  app.use("/seed", express.static(SEED_DIR, { maxAge: "7d", immutable: true }));
}

app.use("/api", ocrRouter);
app.use("/api", evalsRouter);
app.use("/api", datasetsRouter);

app.get("/health", (_req, res) => {
  res.json({ status: "ok", storage: storageMode });
});

async function start() {
  console.log(`[storage] mode: ${storageMode}`);
  const db = await connectDB();
  if (db) {
    try {
      await seedInsuranceMedical(db);
    } catch (e: any) {
      console.warn("[seed] failed:", e.message);
    }
  }
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });
}

start().catch(console.error);
