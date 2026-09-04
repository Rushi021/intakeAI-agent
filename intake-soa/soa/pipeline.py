"""End-to-end SoA extraction for one protocol PDF.

    parse (Docling)  ->  footnote blocks  ->  SoA table scoring + fragment merge
                                ->  verbatim structure  ->  marker linkage  ->  model interpretation

Footnote detection runs before table scoring because it is table-agnostic and cheap: it attaches each
legend to whatever table sits above it, then the locator consumes those attachments as its rule 2
("does a footnote block hang off me?"). Linkage runs last, scoped to the tables the locator selected,
so a marker is never matched against a legend belonging to some other table on the page.
"""
from __future__ import annotations

import json
import time
from collections import Counter
from pathlib import Path

from docling.datamodel.base_models import InputFormat
from docling.datamodel.pipeline_options import (AcceleratorDevice, AcceleratorOptions,
                                                PdfPipelineOptions)
from docling.document_converter import DocumentConverter, PdfFormatOption
from docling_core.types.doc import DoclingDocument

from . import llm
from .extract import apply_linkage, assemble, strip_internals
from .fallback import check_column_axis, recover
from .footnotes import detect_footnotes, item_label, marker_key
from .linkage import link_markers
from .locator import locate

# Docling model inference segfaults the macOS kernel under some Jupyter/Cursor hosts when it spawns
# its own threads, so the accelerator is pinned. Documents run in parallel at the process level
# instead — see server.py.
_ACCELERATOR = AcceleratorOptions(num_threads=1, device=AcceleratorDevice.CPU)

_converter: DocumentConverter | None = None


def converter() -> DocumentConverter:
    """One converter per process — building it loads the layout and table-structure models."""
    global _converter
    if _converter is None:
        _converter = DocumentConverter(format_options={
            InputFormat.PDF: PdfFormatOption(pipeline_options=PdfPipelineOptions(
                do_table_structure=True, do_ocr=False, accelerator_options=_ACCELERATOR))
        })
    return _converter


def parse(pdf_path: Path, cache: Path | None = None) -> tuple[DoclingDocument, float]:
    """Convert a PDF with Docling, reusing a cached dump when one exists.

    Conversion is 35s-4min per protocol; the cache is what makes re-runs and the corpus script quick.
    """
    if cache and cache.is_file():
        return DoclingDocument.model_validate(json.loads(cache.read_text())), 0.0
    t0 = time.perf_counter()
    doc = converter().convert(str(pdf_path)).document
    elapsed = time.perf_counter() - t0
    if cache:
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(doc.export_to_dict(), indent=2, default=str))
    return doc, elapsed


def layout_inventory(doc) -> dict:
    """What Docling saw in this document, by layout label — the per-file metadata view."""
    labels = Counter(item_label(item) for item, _ in doc.iterate_items())
    return {
        "pages": len(getattr(doc, "pages", {}) or {}),
        "tables": len(doc.tables),
        "text_items": len(doc.texts),
        "labels": [{"label": k, "count": v} for k, v in labels.most_common()],
    }


def run(pdf_path, cache: Path | None = None, use_model: bool = True, progress=None) -> dict:
    """Extract every SoA in one protocol. Never raises past the caller — failures are reported."""
    pdf_path = Path(pdf_path)
    step = progress or (lambda *_: None)

    step("parsing", "Converting with Docling")
    doc, elapsed = parse(pdf_path, cache)
    inventory = layout_inventory(doc)

    step("footnotes", "Scoring footnote blocks")
    blocks = detect_footnotes(doc)

    step("locating", "Scoring tables for the Schedule of Activities")
    scored, groups = locate(doc, blocks)

    fallback = {"triggered": False}
    if not groups and use_model:
        step("fallback", "No table scored — asking the model which one is the schedule")
        groups, fallback = recover(doc, scored)

    schedules = []
    for n, group in enumerate(groups, start=1):
        step("extracting", f"Building schedule {n} of {len(groups)}")
        soa = assemble(group, doc, blocks, n)

        defined = {marker_key(note["marker"]) for note in soa["footnotes"]}
        try:
            linked, orphans = link_markers(
                pdf_path,
                [{"page": f["page"], "grid": f["_grid"],
                  "header_rows": f["_header_rows"], "label_cols": f["_label_cols"]}
                 for f in soa["fragments"]],
                defined)
        except Exception as exc:
            linked, orphans = [], []
            soa["linkage_error"] = f"{type(exc).__name__}: {exc}"
        apply_linkage(soa, linked, orphans)
        check_column_axis(soa, use_model)

        soa["interpretation"] = []
        for frag in soa["fragments"]:
            soa["interpretation"].append(
                llm.interpret(frag) if use_model
                else {"status": "skipped", "reason": "model disabled for this run"})
        schedules.append(strip_internals(soa))

    near_miss = [{"table_id": r["table_id"], "page": r["page"], "score": r["score"],
                  "mark_share": r["mark_share"], "gate": r["gate_why"]}
                 for r in scored if r["verdict"] == "review"]

    review = {
        "schedules_found": len(schedules),
        "near_miss_tables": near_miss,
        "footnote_blocks": {
            verdict: sum(1 for b in blocks if b["verdict"] == verdict)
            for verdict in ("accept", "review", "discard")
        },
        "footnote_blocks_flagged": [
            {"page": b["block"]["page"], "score": b["score"], "markers": b["block"]["markers"],
             "attached_to": b["table"]["id"] if b["table"] else None}
            for b in blocks if b["verdict"] == "review"
        ],
    }
    if fallback.get("triggered"):
        review["fallback"] = fallback           # only when the rules found nothing — else no key added

    return {
        "document": {
            "filename": pdf_path.name,
            "converter": "docling",
            "convert_seconds": round(elapsed, 1),
            **inventory,
        },
        "schedules": schedules,
        "review": review,
        "table_scores": [{k: v for k, v in r.items() if k != "fn_blocks"} for r in scored],
    }
