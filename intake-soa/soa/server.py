"""Upload protocol PDFs, extract them in parallel, review the result.

Run:  python -m uvicorn soa.server:app --reload --port 8000   (or: python -m soa.server)

State is in memory and per-process: this is a local review tool for one operator, not a service.
Restarting it clears the queue, which is the correct behaviour for something handling documents the
assignment says not to leave lying around.
"""
from __future__ import annotations

import tempfile
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import llm
from .pipeline import run

WEB = Path(__file__).resolve().parent.parent / "web"
UPLOADS = Path(tempfile.gettempdir()) / "intake-soa-uploads"
UPLOADS.mkdir(exist_ok=True)

MAX_PARALLEL = 4          # documents extracted at once
MAX_UPLOAD_MB = 100

# ponytail: threads, not processes. Docling's heavy work is native (torch, docling-parse) and
# releases the GIL, and a thread pool shares the one loaded model set — a process pool would reload
# ~1GB of models per worker. If pure-Python stages ever dominate, switch to ProcessPoolExecutor and
# pay the model-load cost.
_pool = ThreadPoolExecutor(max_workers=MAX_PARALLEL)

app = FastAPI(title="SoA Extraction")

# doc_id -> {name, path, status, step, message, result, error}
DOCS: dict[str, dict] = {}


def _public(doc: dict) -> dict:
    return {k: doc[k] for k in ("id", "name", "size", "status", "step", "message", "error")}


@app.get("/api/state")
def state():
    return {
        "documents": [_public(d) for d in DOCS.values()],
        "model": {"available": llm.available(), "name": llm.DEFAULT_MODEL},
    }


@app.post("/api/upload")
async def upload(files: list[UploadFile]):
    added = []
    for f in files:
        data = await f.read()
        if not data:
            raise HTTPException(400, f"{f.filename} is empty")
        if len(data) > MAX_UPLOAD_MB * 1024 * 1024:
            raise HTTPException(413, f"{f.filename} is over {MAX_UPLOAD_MB} MB")
        if not data.startswith(b"%PDF"):
            raise HTTPException(415, f"{f.filename} is not a PDF")

        doc_id = uuid.uuid4().hex[:12]
        path = UPLOADS / f"{doc_id}.pdf"
        path.write_bytes(data)
        DOCS[doc_id] = {"id": doc_id, "name": f.filename, "size": len(data), "path": path,
                        "status": "queued", "step": None, "message": None,
                        "result": None, "error": None}
        added.append(_public(DOCS[doc_id]))
    return {"added": added}


@app.delete("/api/document/{doc_id}")
def remove(doc_id: str):
    doc = DOCS.pop(doc_id, None)
    if not doc:
        raise HTTPException(404, "no such document")
    if doc["status"] == "running":
        DOCS[doc_id] = doc
        raise HTTPException(409, "that document is being extracted")
    doc["path"].unlink(missing_ok=True)
    return {"removed": doc_id}


def _extract(doc_id: str, use_model: bool) -> None:
    doc = DOCS.get(doc_id)
    if not doc:
        return                                   # deleted while queued
    doc.update(status="running", step="parsing", message="Starting")
    try:
        def progress(step: str, message: str) -> None:
            if doc_id in DOCS:
                DOCS[doc_id].update(step=step, message=message)
        doc["result"] = run(doc["path"], use_model=use_model, progress=progress)
        doc.update(status="done", step=None,
                   message=f"{len(doc['result']['schedules'])} schedule(s) found")
    except Exception as exc:
        traceback.print_exc()
        doc.update(status="failed", step=None, message=None,
                   error=f"{type(exc).__name__}: {exc}")


@app.post("/api/run")
def start(use_model: bool = True):
    pending = [d for d in DOCS.values() if d["status"] in ("queued", "failed")]
    if not pending:
        raise HTTPException(400, "nothing to extract")
    for doc in pending:
        doc.update(status="queued", error=None, message="Waiting for a worker")
        _pool.submit(_extract, doc["id"], use_model)
    return {"started": [d["id"] for d in pending], "parallel": MAX_PARALLEL}


@app.get("/api/result/{doc_id}")
def result(doc_id: str):
    doc = DOCS.get(doc_id)
    if not doc:
        raise HTTPException(404, "no such document")
    if doc["status"] != "done":
        raise HTTPException(409, f"status is {doc['status']}")
    return JSONResponse(doc["result"])


@app.get("/")
def index():
    return FileResponse(WEB / "index.html")


app.mount("/", StaticFiles(directory=WEB), name="web")


def main() -> None:
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)


if __name__ == "__main__":
    main()
