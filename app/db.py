import os
from datetime import datetime, timezone

from motor.motor_asyncio import AsyncIOMotorClient

client: AsyncIOMotorClient | None = None
db = None


async def connect_db():
    global client, db
    uri = os.environ.get("MONGODB_URI")
    if not uri:
        print("[MongoDB] MONGODB_URI not set — running without database")
        return
    try:
        client = AsyncIOMotorClient(uri, serverSelectionTimeoutMS=5000)
        await client.server_info()
        db = client.ocr_systems
        print(f"[MongoDB] Connected")
    except Exception as e:
        print(f"[MongoDB] Connection failed: {e} — running without database")
        client = None
        db = None


async def close_db():
    global client
    if client:
        client.close()
        print("[MongoDB] Connection closed")


async def save_run(
    image_filename: str,
    engine_ids: list[str],
    results: list[dict],
    prompt: str | None = None,
) -> dict:
    doc = {
        "image_filename": image_filename,
        "engine_ids": engine_ids,
        "prompt": prompt,
        "results": results,
        "created_at": datetime.now(timezone.utc),
    }
    if db is not None:
        inserted = await db.runs.insert_one(doc)
        doc["_id"] = str(inserted.inserted_id)
    else:
        doc["_id"] = "no-db"
    return doc


async def get_runs(limit: int = 50, skip: int = 0) -> list[dict]:
    if db is None:
        return []
    cursor = db.runs.find().sort("created_at", -1).skip(skip).limit(limit)
    runs = await cursor.to_list(length=limit)
    for run in runs:
        run["_id"] = str(run["_id"])
    return runs


async def get_run(run_id: str) -> dict | None:
    if db is None:
        return None
    from bson import ObjectId

    try:
        run = await db.runs.find_one({"_id": ObjectId(run_id)})
    except Exception:
        return None
    if run:
        run["_id"] = str(run["_id"])
    return run


async def delete_run(run_id: str) -> bool:
    if db is None:
        return False
    from bson import ObjectId

    try:
        result = await db.runs.delete_one({"_id": ObjectId(run_id)})
    except Exception:
        return False
    return result.deleted_count > 0


async def get_run_count() -> int:
    if db is None:
        return 0
    return await db.runs.count_documents({})
