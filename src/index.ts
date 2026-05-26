import "dotenv/config";
import express from "express";
import cors from "cors";
import { connectDB } from "./db.js";
import ocrRouter from "./routes/ocr.js";

const app = express();
const PORT = parseInt(process.env.PORT || "8000", 10);

app.use(cors());
app.use(express.json());

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
