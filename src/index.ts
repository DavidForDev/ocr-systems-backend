import "dotenv/config";
import express from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectDB } from "./db.js";
import ocrRouter from "./routes/ocr.js";
import { UPLOADS_DIR } from "./routes/ocr.js";
import evalsRouter from "./routes/evals.js";
import datasetsRouter from "./routes/datasets.js";
import { seedInsuranceMedical } from "./seed/insuranceMedical.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_DIR = path.resolve(__dirname, "../seed");

const app = express();
const PORT = parseInt(process.env.PORT || "8000", 10);

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Stored run images.
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
app.use(
  "/uploads",
  express.static(UPLOADS_DIR, { maxAge: "7d", immutable: true })
);

// Built-in dataset images.
app.use("/seed", express.static(SEED_DIR, { maxAge: "7d", immutable: true }));

app.use("/api", ocrRouter);
app.use("/api", evalsRouter);
app.use("/api", datasetsRouter);

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

async function start() {
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
