import { MongoClient, Db } from "mongodb";

let db: Db | null = null;
let client: MongoClient | null = null;

export async function connectDB(): Promise<Db | null> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.log("MONGODB_URI not set — running without database");
    return null;
  }

  try {
    client = new MongoClient(uri);
    await client.connect();
    db = client.db();
    console.log("Connected to MongoDB");
    return db;
  } catch (e: any) {
    console.warn("MongoDB connection failed:", e.message);
    return null;
  }
}

export function getDB(): Db | null {
  return db;
}
