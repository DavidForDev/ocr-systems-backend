import "dotenv/config";
import express from "express";
import cors from "cors";
import fs from "node:fs";
import { connectDB } from "./db.js";
import datasetsRouter from "./routes/datasets.js";
import runsRouter from "./routes/runs.js";
import { LOCAL_UPLOADS_DIR, storageMode } from "./storage.js";

const app = express();
const PORT = parseInt(process.env.PORT || "8000", 10);

app.use(cors());
app.use(express.json({ limit: "10mb" }));

if (storageMode === "local") {
  fs.mkdirSync(LOCAL_UPLOADS_DIR, { recursive: true });
  app.use("/uploads", express.static(LOCAL_UPLOADS_DIR, { maxAge: "7d", immutable: true }));
}

app.use("/api", datasetsRouter);
app.use("/api", runsRouter);

app.get("/health", (_req, res) => {
  res.json({ status: "ok", storage: storageMode });
});

async function start() {
  console.log(`[storage] mode: ${storageMode}`);
  await connectDB();
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });
}

start().catch(console.error);
