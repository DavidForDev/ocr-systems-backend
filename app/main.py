from contextlib import asynccontextmanager
from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

load_dotenv()

from app.engines import load_engines
from app.db import connect_db, close_db
from app.routers import ocr


@asynccontextmanager
async def lifespan(app: FastAPI):
    await connect_db()
    app.state.engines = load_engines()
    print(f"\n=== {len(app.state.engines)} OCR engines loaded ===\n")
    yield
    await close_db()


app = FastAPI(title="OCR Systems Tester", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(ocr.router, prefix="/api")


@app.get("/api/health")
async def health():
    return {"status": "ok"}
