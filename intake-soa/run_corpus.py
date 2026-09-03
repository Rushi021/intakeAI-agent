#!/usr/bin/env python3
"""Extract every protocol in ../takehome-1b/ and commit the structured output to outputs/.

    python run_corpus.py            # all five, using cached Docling dumps where present
    python run_corpus.py --no-model # skip the interpretation call (no API key needed)
    python run_corpus.py protocol9  # one document

The committed JSON in outputs/*-soa.json is produced by exactly this script — it is the assignment's
"structured output for all five protocols" deliverable, not a hand-edited file.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from soa.pipeline import run

HERE = Path(__file__).resolve().parent
PROTOCOLS = (HERE / ".." / "takehome-1b").resolve()
OUTPUTS = HERE / "outputs"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("names", nargs="*", help="protocol stems; default is every PDF found")
    ap.add_argument("--no-model", action="store_true", help="skip the LLM interpretation step")
    args = ap.parse_args()

    pdfs = ([PROTOCOLS / f"{n}.pdf" for n in args.names] if args.names
            else sorted(PROTOCOLS.glob("*.pdf")))
    missing = [p for p in pdfs if not p.is_file()]
    if missing:
        print(f"Not found: {', '.join(p.name for p in missing)}", file=sys.stderr)
        print(f"Unzip the protocol PDFs into {PROTOCOLS}", file=sys.stderr)
        return 1

    OUTPUTS.mkdir(exist_ok=True)
    for pdf in pdfs:
        print(f"\n=== {pdf.name}")
        result = run(pdf, cache=OUTPUTS / f"{pdf.stem}-docling.json",
                     use_model=not args.no_model,
                     progress=lambda s, m: print(f"  [{s}] {m}"))
        out = OUTPUTS / f"{pdf.stem}-soa.json"
        out.write_text(json.dumps(result, indent=2, default=str))

        for soa in result["schedules"]:
            frags = soa["fragments"]
            rows = sum(len(f["rows"]) for f in frags)
            cols = sum(len(f["columns"]) for f in frags)
            linked = sum(len(n["targets"]) for n in soa["footnotes"])
            print(f"  {soa['soa_id']}: pages {soa['pages']}  {len(frags)} fragment(s)  "
                  f"{rows} rows  {cols} columns  {len(soa['footnotes'])} footnotes  "
                  f"{linked} marker linkages")
            unl = soa["review"]["footnotes_never_used_in_table"]
            orph = soa["review"]["markers_in_table_without_definition"]
            if unl:
                print(f"    review — footnotes with no target in the table: {unl}")
            if orph:
                print(f"    review — markers in the table with no definition: {orph}")
        if not result["schedules"]:
            print("  NO SCHEDULE FOUND — near misses:", result["review"]["near_miss_tables"])
        print(f"  wrote {out.relative_to(HERE)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
