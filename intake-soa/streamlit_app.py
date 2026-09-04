"""Extractor Agent Result — the five committed SoA extractions, rendered.

A separate, standalone page from the FastAPI review tool (`soa/server.py`, `web/`). That one drives a
live extraction against any uploaded protocol PDF. This one is the fixed submission deliverable — the
Schedule of Activities table already extracted and committed for all five supplied protocols
(`outputs/*-soa.json`, produced by `run_corpus.py`) — read straight off disk and shown as a table.
Nothing here re-runs Docling, pdfplumber, or the model.

Run:  streamlit run streamlit_app.py
"""
from __future__ import annotations

import json
from pathlib import Path

import pandas as pd
import streamlit as st

OUT = Path(__file__).resolve().parent / "outputs"

# The five protocols this assignment grades against. Hardcoded on purpose — this page shows the fixed
# deliverable output, not a live tool. For "any protocol PDF, extracted live" see soa/server.py.
PROTOCOLS = ["protocol1", "protocol5", "protocol9", "protocol12", "protocol15"]

st.set_page_config(page_title="Extractor Agent Result", layout="wide")
st.title("Extractor Agent Result")
st.caption(
    "The Schedule of Activities extracted from each of the five supplied protocols, read from the "
    "committed output in outputs/*-soa.json — the same files the corpus run produced, unedited."
)


def grid(fragment: dict) -> pd.DataFrame:
    """One fragment's sparse `{row, col, value}` cells, reconstructed into a dense grid for display
    only — the committed JSON stays sparse; this is a rendering convenience, nothing more."""
    cols = sorted(fragment["columns"], key=lambda c: c["col_index"])
    rows = sorted(fragment["rows"], key=lambda r: r["row_index"])
    by_pos = {(c["row"], c["col"]): c["value"] for c in fragment["cells"]}

    header = ["Activity"] + [" / ".join(c["header_path"]) for c in cols]
    data = [
        [("    " + r["label"]) if r["kind"] == "activity" else r["label"]]
        + [by_pos.get((r["row_index"], c["col_index"]), "") for c in cols]
        for r in rows
    ]
    return pd.DataFrame(data, columns=header)


tabs = st.tabs(PROTOCOLS)
for name, tab in zip(PROTOCOLS, tabs):
    with tab:
        path = OUT / f"{name}-soa.json"
        if not path.is_file():
            st.error(f"{path.name} not found — run `python run_corpus.py {name}` first.")
            continue

        result = json.loads(path.read_text())
        doc = result["document"]
        st.caption(
            f"{doc['pages']} pages · {doc['tables']} tables detected · "
            f"{len(result['schedules'])} schedule(s) found · {doc['convert_seconds']}s to convert"
        )

        if not result["schedules"]:
            st.warning("No Schedule of Activities located in this protocol.")
            continue

        for sched in result["schedules"]:
            st.subheader(sched["soa_id"])
            for frag in sched["fragments"]:
                r, c = frag["grid_size"]
                st.markdown(f"page {frag['page']} · table `{frag['table_id']}` · {r} rows × {c} cols")
                st.dataframe(grid(frag), width="stretch", hide_index=True)

            if sched["footnotes"]:
                st.markdown("**Footnotes**")
                for fn in sched["footnotes"]:
                    st.markdown(f"- `{fn['marker']}` — {fn['text']}")
