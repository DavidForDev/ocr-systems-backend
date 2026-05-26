import asyncio
import json
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from functools import partial

from fastapi import APIRouter, File, Form, Request, UploadFile, HTTPException
from PIL import Image
import io

from app.utils.schema_extractor import extract_fields
from app.db import save_run, get_runs, get_run, delete_run, get_run_count

router = APIRouter()
executor = ThreadPoolExecutor(max_workers=4)


@router.get("/engines")
async def list_engines(request: Request):
    engines = request.app.state.engines
    return {
        "engines": [engine.info() for engine in engines.values()],
        "count": len(engines),
    }


@router.post("/ocr")
async def run_ocr(
    request: Request,
    file: UploadFile = File(...),
    engine_id: str = Form(...),
    prompt: str | None = Form(None),
    output_schema: str | None = Form(None),
):
    engines = request.app.state.engines
    if engine_id not in engines:
        raise HTTPException(status_code=404, detail=f"Engine '{engine_id}' not found")

    image = Image.open(io.BytesIO(await file.read())).convert("RGB")
    engine = engines[engine_id]

    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(
        executor, partial(engine.recognize, image, prompt=prompt)
    )

    output = asdict(result)

    if output_schema and result.text:
        try:
            schema_fields = json.loads(output_schema)
            if isinstance(schema_fields, list):
                output["fields"] = await loop.run_in_executor(
                    executor, extract_fields, result.text, schema_fields
                )
        except json.JSONDecodeError:
            output["fields_error"] = 'Invalid schema JSON. Pass a list like ["name", "date", "total"]'

    saved = await save_run(
        image_filename=file.filename or "unknown",
        engine_ids=[engine_id],
        prompt=prompt,
        results=[output],
    )
    output["run_id"] = saved["_id"]

    return output


@router.post("/ocr/compare")
async def compare_engines(
    request: Request,
    file: UploadFile = File(...),
    engine_ids: str | None = Form(None),
    prompt: str | None = Form(None),
    output_schema: str | None = Form(None),
):
    engines = request.app.state.engines
    image_bytes = await file.read()
    image = Image.open(io.BytesIO(image_bytes)).convert("RGB")

    # Select engines: if engine_ids provided, use those; otherwise use all
    if engine_ids:
        try:
            selected_ids = json.loads(engine_ids)
        except json.JSONDecodeError:
            raise HTTPException(status_code=400, detail="engine_ids must be a JSON list")

        if not isinstance(selected_ids, list) or not selected_ids:
            raise HTTPException(status_code=400, detail="engine_ids must be a non-empty list")

        missing = [eid for eid in selected_ids if eid not in engines]
        if missing:
            raise HTTPException(status_code=404, detail=f"Engines not found: {missing}")

        selected_engines = {eid: engines[eid] for eid in selected_ids}
    else:
        selected_engines = engines

    loop = asyncio.get_event_loop()

    # Parse schema fields if provided
    schema_fields = None
    if output_schema:
        try:
            schema_fields = json.loads(output_schema)
            if not isinstance(schema_fields, list):
                schema_fields = None
        except json.JSONDecodeError:
            pass

    async def run_engine(engine):
        img_copy = image.copy()
        result = await loop.run_in_executor(
            executor, partial(engine.recognize, img_copy, prompt=prompt)
        )
        output = asdict(result)

        if schema_fields and result.text:
            output["fields"] = await loop.run_in_executor(
                executor, extract_fields, result.text, schema_fields
            )

        return output

    tasks = [run_engine(engine) for engine in selected_engines.values()]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    output = []
    for engine, result in zip(selected_engines.values(), results):
        if isinstance(result, Exception):
            output.append({
                "text": "",
                "confidence": None,
                "processing_time": 0,
                "engine_id": engine.id,
                "engine_name": engine.name,
                "error": str(result),
                "metadata": {},
            })
        else:
            output.append(result)

    saved = await save_run(
        image_filename=file.filename or "unknown",
        engine_ids=list(selected_engines.keys()),
        prompt=prompt,
        results=output,
    )

    return {
        "run_id": saved["_id"],
        "results": output,
    }


# ── Results History ──────────────────────────────────────────────


@router.get("/results")
async def list_results(limit: int = 50, skip: int = 0):
    runs = await get_runs(limit=limit, skip=skip)
    total = await get_run_count()
    return {
        "runs": runs,
        "total": total,
        "limit": limit,
        "skip": skip,
    }


@router.get("/results/{run_id}")
async def get_result_by_id(run_id: str):
    run = await get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    return run


@router.delete("/results/{run_id}")
async def delete_result(run_id: str):
    deleted = await delete_run(run_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Run not found")
    return {"deleted": True}
