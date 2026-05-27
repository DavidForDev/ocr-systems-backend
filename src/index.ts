import "dotenv/config";
import express from "express";
import cors from "cors";
import fs from "node:fs";
import { connectDB } from "./db.js";
import ocrRouter from "./routes/ocr.js";
import { UPLOADS_DIR } from "./routes/ocr.js";

const app = express();
const PORT = parseInt(process.env.PORT || "8000", 10);

app.use(cors());
app.use(express.json());

// Make sure the uploads directory exists, then serve stored images statically.
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
app.use(
  "/uploads",
  express.static(UPLOADS_DIR, { maxAge: "7d", immutable: true })
);

app.use("/api", ocrRouter);

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

async function start() {
  await connectDB();
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });
}

start().catch(console.error);
