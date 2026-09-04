"""Mistral call for the interpretation layer only: header-row roles and row category structure.

Scope is deliberately narrow. The model is sent the header rows and the row labels — never the cell
values, never the protocol text — and its answer is validated index-by-index against the structure
we already extracted. Anything it omits, invents, or mislabels falls back to the rule-based default
and is recorded in `review`. This is what keeps a hallucination from deleting a row or a visit, the
failure the assignment penalizes most heavily.

Sending less also matters for the assignment's ground rule about not uploading protocols anywhere
they would be retained: what leaves the machine is one table's headers and row labels, not the
document. Point a paid (no-train) Mistral key at it, or run with no key at all — see the README.
"""
from __future__ import annotations

import json
import os
import pathlib

import requests

API_URL = "https://api.mistral.ai/v1/chat/completions"
DEFAULT_MODEL = "mistral-large-latest"
# A key whose tier does not carry the large model answers 403 rather than falling back on its own,
# so the chain is walked here. Same behaviour as Part 1 of this take-home.
FALLBACK_MODELS = ("mistral-medium-latest", "mistral-small-latest")
TIMEOUT_S = 90
MAX_LABELS = 200          # a fragment with more rows than this is truncated for the prompt

SYSTEM = """You label the structure of a clinical trial Schedule of Activities table.
You are given the table's stacked header rows and its row labels, already extracted verbatim.
Return JSON only. Never invent, reword, translate, merge or drop an index — echo every index you
were given exactly once.

For each header row, assign one role:
  study_period  - a banding like Screening / Treatment / Follow-up
  visit_name    - a named visit
  visit_number  - visit numbering
  study_day     - study day numbering
  study_week    - study week numbering
  visit_window  - the allowable window, e.g. plus or minus 3 days
  other         - anything else

For each row, decide whether it is a "category" (a grouping heading such as "Safety Assessments",
which is structure, not an assessment) or an "activity" (something actually performed), and give the
row_index of the category it sits under, or null.

Reply exactly: {"header_roles":[{"row_index":int,"role":str}],
                "rows":[{"row_index":int,"kind":"category"|"activity","parent":int|null}]}"""


def _load_key() -> str | None:
    key = os.environ.get("MISTRAL_API_KEY")
    if key:
        return key.strip()
    for env in (pathlib.Path(__file__).resolve().parent.parent / ".env",
                pathlib.Path(__file__).resolve().parent.parent.parent / "intake-agent" / ".env"):
        if env.is_file():
            for line in env.read_text().splitlines():
                name, _, value = line.partition("=")
                if name.strip() in ("MISTRAL_API_KEY", "VITE_MISTRAL_API_KEY") and value.strip():
                    return value.strip()
    return None


def available() -> bool:
    return _load_key() is not None


def _models() -> tuple[str, ...]:
    chosen = os.environ.get("MISTRAL_MODEL")
    return (chosen,) if chosen else (DEFAULT_MODEL,) + FALLBACK_MODELS


def _call(payload: dict, system: str = SYSTEM) -> tuple[dict, str]:
    key = _load_key()
    last: Exception | None = None
    for model in _models():
        resp = requests.post(
            API_URL,
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            json={
                "model": model,
                "temperature": 0,
                "response_format": {"type": "json_object"},
                "messages": [{"role": "system", "content": system},
                             {"role": "user", "content": json.dumps(payload)}],
            },
            timeout=TIMEOUT_S,
        )
        if resp.status_code == 403:
            last = RuntimeError(f"{model}: 403 not available on this key's tier")
            continue
        resp.raise_for_status()
        return json.loads(resp.json()["choices"][0]["message"]["content"]), model
    raise last or RuntimeError("no model available")


def interpret(fragment: dict) -> dict:
    """Apply model-assigned roles and row hierarchy to one fragment, in place.

    Returns a report: what the model changed, and what it failed to answer for.
    """
    if not available():
        return {"status": "skipped", "reason": "no MISTRAL_API_KEY — rule-based defaults kept"}

    payload = {
        "header_rows": [{"row_index": h["row_index"], "cells": h["cells"]}
                        for h in fragment["header_rows"]],
        "rows": [{"row_index": r["row_index"], "label": r["label"]}
                 for r in fragment["rows"][:MAX_LABELS] if r["label"]],
    }
    if not payload["rows"]:
        return {"status": "skipped", "reason": "fragment has no row labels"}

    try:
        answer, model = _call(payload)
    except Exception as exc:                     # network, auth, quota, malformed JSON
        return {"status": "failed", "reason": f"{type(exc).__name__}: {exc}",
                "note": "rule-based defaults kept; no structure was lost"}

    roles = {int(h["row_index"]): h.get("role") for h in answer.get("header_roles", [])
             if isinstance(h, dict) and "row_index" in h}
    applied_roles = 0
    for hdr in fragment["header_rows"]:
        role = roles.get(hdr["row_index"])
        if role in ("study_period", "visit_name", "visit_number", "study_day",
                    "study_week", "visit_window", "other"):
            hdr["role"], hdr["role_source"] = role, "model"
            applied_roles += 1

    said = {int(r["row_index"]): r for r in answer.get("rows", [])
            if isinstance(r, dict) and "row_index" in r}
    known = {r["row_index"] for r in fragment["rows"]}
    applied_rows = 0
    for row in fragment["rows"]:
        got = said.get(row["row_index"])
        if not got:
            continue
        if got.get("kind") in ("category", "activity"):
            row["kind"], row["kind_source"] = got["kind"], "model"
            applied_rows += 1
        parent = got.get("parent")
        if isinstance(parent, int) and parent in known and parent != row["row_index"]:
            row["parent"] = parent

    labelled = [r["row_index"] for r in fragment["rows"] if r["label"]]
    return {
        "status": "ok",
        "model": model,
        "header_roles_applied": applied_roles,
        "rows_applied": applied_rows,
        "rows_unanswered": sorted(set(labelled) - set(said)),
        "indices_invented": sorted(set(said) - known),
    }
