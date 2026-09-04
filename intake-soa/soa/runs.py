"""A local record of every run, from both halves of the assignment.

One SQLite file, one table, stdlib only. The two halves produce different work but answer the same
three questions — how much came out, how much was asked for, and how much still needs a person —
so they share a row shape rather than a table each:

    part='soa'    one protocol PDF extracted   produced=schedules found   flagged=review flags
    part='agent'  one study built on a platform produced=items completed  flagged=escalations

`detail` carries whatever else that run wants to keep, as JSON. Nothing reads it in SQL, so it
never needs a migration when a run learns to record something new.

Write:  soa.server calls log() when a document finishes; `python -m soa.runs ingest <lane.json>…`
        loads the agent's bench output.
Read:   GET /api/runs, rendered at /runs.html.
"""
from __future__ import annotations

import json
import sqlite3
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

DB = Path(__file__).resolve().parent.parent / "outputs" / "runs.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
  id       TEXT PRIMARY KEY,
  started  TEXT NOT NULL,
  part     TEXT NOT NULL,
  subject  TEXT NOT NULL,
  input    TEXT,
  status   TEXT NOT NULL,
  seconds  REAL,
  produced INTEGER,
  expected INTEGER,
  flagged  INTEGER,
  detail   TEXT
);
CREATE INDEX IF NOT EXISTS runs_started ON runs (started DESC);
"""


def connect(db: Path | None = None) -> sqlite3.Connection:
    path = Path(db or DB)
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path)
    con.row_factory = sqlite3.Row
    con.executescript(SCHEMA)
    return con


def log(part: str, subject: str, status: str, *, input: str = "", seconds: float | None = None,
        produced: int | None = None, expected: int | None = None, flagged: int | None = None,
        detail: dict | None = None, db: Path | None = None) -> str:
    """Record one run. Returns its id. Never raises past the caller: a logging failure must not
    take down the extraction it was recording."""
    run_id = uuid.uuid4().hex[:12]
    try:
        with connect(db) as con:
            con.execute(
                "INSERT INTO runs (id, started, part, subject, input, status, seconds,"
                " produced, expected, flagged, detail) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (run_id, datetime.now(timezone.utc).isoformat(timespec="seconds"), part, subject,
                 input, status, seconds, produced, expected, flagged,
                 json.dumps(detail or {}, default=str)),
            )
    except (sqlite3.Error, OSError) as exc:            # locked file, read-only checkout, no disk
        print(f"run log failed: {exc}", file=sys.stderr)
    return run_id


def recent(limit: int = 200, part: str | None = None, db: Path | None = None) -> list[dict]:
    with connect(db) as con:
        rows = con.execute(
            "SELECT * FROM runs" + (" WHERE part = ?" if part else "") + " ORDER BY started DESC LIMIT ?",
            ((part, limit) if part else (limit,)),
        ).fetchall()
    return [{**dict(r), "detail": json.loads(r["detail"] or "{}")} for r in rows]


def totals(db: Path | None = None) -> list[dict]:
    """One summary row per part, for the dashboard header."""
    with connect(db) as con:
        return [dict(r) for r in con.execute(
            "SELECT part, COUNT(*) runs, SUM(produced) produced, SUM(expected) expected,"
            " SUM(flagged) flagged, ROUND(AVG(seconds),1) avg_seconds,"
            " SUM(status != 'done') not_done FROM runs GROUP BY part ORDER BY part")]


# ---------------------------------------------------------------------------
# Part 1 — the agent's bench output, which is written as one JSON file per lane
# ---------------------------------------------------------------------------

def ingest_lane(path: Path, db: Path | None = None) -> str:
    """Load one `intake-agent/bench/out/<lane>.json`. Counts come from the grader in lane.mjs
    (the built study read back and compared with the input file), not from the agent's own tally —
    a run that miscounts itself should show up here as a discrepancy, not be hidden by it."""
    r = json.loads(Path(path).read_text())
    if "score" not in r or "panel" not in r:
        raise ValueError(f"{path} is not a lane result (no score/panel)")
    score = r["score"] or {"seen": {}, "want": {}, "findings": []}
    cards = (r.get("panel") or {}).get("cards") or []
    ledger = (r.get("panel") or {}).get("ledger") or ""
    states: dict[str, int] = {}
    for line in ledger.splitlines():
        parts = line.split("  ·  ")
        if len(parts) > 1:
            states[parts[1]] = states.get(parts[1], 0) + 1

    return log(
        "agent",
        # The file name, not the lane name inside it: two repetitions of one lane
        # are two runs, and telling them apart is the point of a log.
        subject=Path(path).stem,
        input=r.get("ir", ""),
        status="failed" if r.get("error") else "timeout" if r.get("timedOut") else "done",
        seconds=round((r.get("ms") or 0) / 1000, 1),
        produced=score["seen"].get("fields", 0),
        expected=score["want"].get("fields", 0),
        flagged=states.get("escalated", 0),
        detail={
            "url": r.get("url"),
            "panel_status": (r.get("panel") or {}).get("status", ""),
            "visits": f"{score['seen'].get('visits', 0)}/{score['want'].get('visits', 0)}",
            "forms": f"{score['seen'].get('forms', 0)}/{score['want'].get('forms', 0)}",
            "ledger_states": states,
            "findings": score["findings"][:200],
            "gate_cards": [{"signature": c.get("signature", ""), "question": c.get("question", ""),
                            "blocks": c.get("blocks", ""), "tried": c.get("tried", "")} for c in cards],
            "console_errors": r.get("consoleErrors", [])[:20],
        },
        db=db,
    )


def _selfcheck() -> None:
    """Runnable check: a round trip through a scratch database."""
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        db = Path(tmp) / "t.db"
        log("soa", "protocol1.pdf", "done", seconds=12.5, produced=1, flagged=2, detail={"a": 1}, db=db)
        log("agent", "mockA-smoke", "done", input="test.ir.json", produced=34, expected=34, flagged=0, db=db)
        rows = recent(db=db)
        assert len(rows) == 2, rows
        assert {r["part"] for r in rows} == {"soa", "agent"}
        assert rows[0]["detail"] == {"a": 1} or rows[1]["detail"] == {"a": 1}
        assert [t["part"] for t in totals(db=db)] == ["agent", "soa"]
        # A bad path must not raise — logging is never allowed to fail a run.
        # The warning it prints next is the check working, not a failure.
        print("  expecting one 'run log failed' warning:")
        assert log("soa", "x", "done", db=Path("/proc/nope/nope.db")) != ""
    print("runs: all checks passed")


if __name__ == "__main__":
    args = sys.argv[1:]
    if args[:1] == ["ingest"]:
        for p in args[1:]:
            print(f"{ingest_lane(Path(p))}  {p}")
    elif args[:1] == ["list"]:
        for r in recent():
            print(f"{r['started']}  {r['part']:6}  {r['subject']:22}  {r['status']:8}"
                  f"  {r['produced']}/{r['expected']}  flagged {r['flagged']}")
    else:
        _selfcheck()
