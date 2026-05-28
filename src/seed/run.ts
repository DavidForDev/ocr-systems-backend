/**
 * Manual seed runner.
 *
 *   npm run seed           — idempotent (no-op if dataset already exists)
 *   npm run seed -- --force — delete the existing seed and re-upload images
 *
 * Useful after first wiring up R2 to push the bundled seed images into the
 * bucket and rewrite the dataset to use R2 URLs.
 */
import "dotenv/config";
import { connectDB } from "../db.js";
import { seedInsuranceMedical } from "./insuranceMedical.js";
import { storageMode } from "../storage.js";

async function main() {
  const force = process.argv.includes("--force");
  console.log(`[seed] storage: ${storageMode}${force ? " · force=true" : ""}`);
  const db = await connectDB();
  if (!db) {
    console.error("MONGODB_URI is not set — can't seed without a database.");
    process.exit(1);
  }
  await seedInsuranceMedical(db, { force });
  console.log("[seed] done");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
