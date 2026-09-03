/* SoA extraction review UI.
   Renders whatever the pipeline returns for whatever PDF was uploaded — there is nothing
   protocol-specific in here, and no pre-computed result is ever displayed. */

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

let state = { documents: [], model: {} };
let active = null;          // doc id shown in the preview
let polling = null;

/* ---------- server ---------- */

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function refresh() {
  state = await api("/api/state");
  renderRail();
  renderTabs();
  const doc = state.documents.find((d) => d.id === active);
  if (doc && doc.status === "done" && !doc._result) {
    doc._result = await api(`/api/result/${doc.id}`);
  }
  renderPanel();

  const busy = state.documents.some((d) => d.status === "running" || d.status === "queued");
  if (busy && !polling) polling = setInterval(refresh, 900);
  if (!busy && polling) { clearInterval(polling); polling = null; }
}

/* ---------- upload queue ---------- */

async function addFiles(list) {
  const pdfs = [...list].filter((f) => /\.pdf$/i.test(f.name) || f.type === "application/pdf");
  if (!pdfs.length) return;
  const body = new FormData();
  pdfs.forEach((f) => body.append("files", f));
  try {
    await api("/api/upload", { method: "POST", body });
  } catch (e) {
    $("railNote").textContent = e.message;
  }
  refresh();
}

$("picker").addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });

const drop = $("drop");
["dragenter", "dragover"].forEach((t) =>
  drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("is-over"); }));
["dragleave", "drop"].forEach((t) =>
  drop.addEventListener(t, () => drop.classList.remove("is-over")));
drop.addEventListener("drop", (e) => { e.preventDefault(); addFiles(e.dataTransfer.files); });

$("run").addEventListener("click", async () => {
  $("run").disabled = true;
  try { await api("/api/run", { method: "POST" }); } catch (e) { $("railNote").textContent = e.message; }
  refresh();
});

function renderRail() {
  const q = $("queue");
  q.replaceChildren();

  const docs = state.documents;
  const done = docs.filter((d) => d.status === "done").length;
  $("queueCount").textContent = docs.length
    ? `${docs.length} document${docs.length > 1 ? "s" : ""}${done ? ` · ${done} extracted` : ""}`
    : "No documents yet";

  const m = state.model || {};
  $("modelState").textContent = m.available ? "model on" : "rules only";
  $("modelState").style.color = m.available ? "var(--ok)" : "var(--ink-3)";

  for (const d of docs) {
    const row = el("div", "doc");
    row.dataset.status = d.status;
    row.appendChild(el("div", "doc__name", d.name));

    const meta = el("div", "doc__meta");
    if (d.status === "queued")  meta.textContent = `${(d.size / 1048576).toFixed(1)} MB · waiting`;
    if (d.status === "running") meta.textContent = d.message || "working";
    if (d.status === "done")    meta.textContent = d.message || "done";
    if (d.status === "failed")  meta.appendChild(el("em", null, d.error || "failed"));
    row.appendChild(meta);

    const x = el("button", "doc__x", "×");
    x.title = `Remove ${d.name}`;
    x.setAttribute("aria-label", `Remove ${d.name}`);
    x.disabled = d.status === "running";
    x.addEventListener("click", async () => {
      await api(`/api/document/${d.id}`, { method: "DELETE" }).catch(() => {});
      if (active === d.id) active = null;
      refresh();
    });
    row.appendChild(x);
    q.appendChild(row);
  }

  const pending = docs.filter((d) => d.status === "queued" || d.status === "failed").length;
  const running = docs.some((d) => d.status === "running");
  $("run").disabled = !pending || running;
  $("run").textContent = running ? "Extracting…"
    : pending ? `Run agent on ${pending} document${pending > 1 ? "s" : ""}` : "Run agent";

  $("railNote").textContent = m.available
    ? `Header roles and row grouping are read by ${m.name}. Cell values, footnotes and linkage are always rule-based.`
    : "No MISTRAL_API_KEY found — running on rules alone. Extraction is complete either way; only the header-role and row-grouping labels are less precise.";
}

/* ---------- tabs ---------- */

function renderTabs() {
  const tabs = $("tabs");
  tabs.replaceChildren();
  const done = state.documents.filter((d) => d.status === "done");
  if (!done.some((d) => d.id === active)) active = done.length ? done[0].id : null;

  for (const d of done) {
    const t = el("button", "tab");
    t.setAttribute("role", "tab");
    t.setAttribute("aria-selected", String(d.id === active));
    t.append(d.name.replace(/\.pdf$/i, ""), " ");
    const n = (d._result?.schedules?.length ?? "");
    t.appendChild(el("i", null, n === "" ? "" : `${n} SoA`));
    t.addEventListener("click", async () => {
      active = d.id;
      if (!d._result) d._result = await api(`/api/result/${d.id}`);
      renderTabs(); renderPanel();
    });
    tabs.appendChild(t);
  }
}

/* ---------- preview ---------- */

function renderPanel() {
  const panel = $("panel");
  panel.replaceChildren();
  const doc = state.documents.find((d) => d.id === active);

  if (!doc || !doc._result) {
    const busy = state.documents.some((d) => d.status === "running");
    const e = el("div", "empty");
    e.appendChild(el("b", null, busy ? "Extracting" : "Nothing extracted yet"));
    e.appendChild(el("span", null, busy
      ? "Results appear as each document finishes."
      : "Add one or more protocols, then run the agent. Each document is parsed in parallel."));
    panel.appendChild(e);
    return;
  }

  const r = doc._result;
  panel.appendChild(documentFacts(r.document));

  if (!r.schedules.length) {
    const b = el("div", "block");
    const h = el("div", "block__head");
    h.appendChild(el("h2", null, "No Schedule of Activities found"));
    h.appendChild(el("span", "pill pill--flag", "review"));
    b.appendChild(h);
    const body = el("div", "block__body");
    body.appendChild(el("p", null,
      "Every table was scored and none reached the selection threshold. The closest are listed below — " +
      "this is a miss the tool reports rather than hides."));
    body.appendChild(nearMisses(r.review.near_miss_tables));
    b.appendChild(body);
    panel.appendChild(b);
  }

  r.schedules.forEach((soa) => panel.appendChild(scheduleBlock(soa, doc)));
  panel.appendChild(reviewBlock(r, doc));
}

function documentFacts(d) {
  const wrap = el("div");
  const facts = el("div", "facts");
  [["pages", d.pages], ["tables found", d.tables], ["text items", d.text_items],
   ["parse", d.convert_seconds ? `${d.convert_seconds}s` : "cached"]].forEach(([k, v]) => {
    const f = el("div");
    f.appendChild(el("div", "fact__n", String(v)));
    f.appendChild(el("div", "fact__k", k));
    facts.appendChild(f);
  });
  wrap.appendChild(facts);

  const labels = el("div", "labels");
  d.labels.forEach((l) => {
    const chip = el("span", "label");
    chip.append(l.label.replace(/_/g, " "), " ");
    chip.appendChild(el("b", null, String(l.count)));
    labels.appendChild(chip);
  });
  wrap.appendChild(labels);
  return wrap;
}

function scheduleBlock(soa, doc) {
  const block = el("div", "block");
  const head = el("div", "block__head");
  head.appendChild(el("h2", null, `Schedule ${soa.soa_id.split("-")[1]}`));
  head.appendChild(el("p", null,
    `page ${soa.pages.join(", ")} · ${soa.fragments.length} fragment${soa.fragments.length > 1 ? "s" : ""}`));

  const best = Math.max(...soa.detection.map((x) => x.score));
  head.appendChild(el("span", best >= 2 ? "pill pill--ok" : "pill pill--info", `score ${best}`));
  const linked = soa.footnotes.reduce((n, f) => n + f.targets.length, 0);
  head.appendChild(el("span", "pill pill--info", `${soa.footnotes.length} footnotes · ${linked} linked`));
  block.appendChild(head);

  const body = el("div", "block__body");
  soa.fragments.forEach((frag, i) => {
    if (soa.fragments.length > 1) {
      const cap = el("p", null, `Fragment ${i + 1} — page ${frag.page}, ${frag.grid_size[0]} × ${frag.grid_size[1]}`);
      cap.style.cssText = "margin:0 0 8px;font-size:12.5px;color:var(--ink-2);font-family:var(--mono)";
      body.appendChild(cap);
    }
    body.appendChild(gridFor(frag));
  });

  if (soa.footnotes.length) {
    const h = el("h3", null, "Footnotes");
    h.style.cssText = "font-size:13px;margin:22px 0 6px";
    body.appendChild(h);
    body.appendChild(notesFor(soa));
  }
  block.appendChild(body);
  return block;
}

/* Renders one fragment verbatim: every header row, every row, every cell value as extracted.
   Markers are drawn where the linkage says they sit. */
function gridFor(frag) {
  const scroll = el("div", "grid__scroll");
  const table = el("table", "grid");
  const cols = frag.columns;
  const byCell = new Map(frag.cells.map((c) => [`${c.row}:${c.col}`, c]));

  const thead = el("thead");
  frag.header_rows.forEach((hr) => {
    const tr = el("tr");
    const stub = el("th", "stub");
    stub.appendChild(document.createTextNode(frag.label_cols.map((i) => hr.cells[i] || "").join(" ").trim()));
    stub.appendChild(el("em", null, hr.role.replace(/_/g, " ")));
    if (hr.markers) stub.append(...markerNodes(hr.markers));
    tr.appendChild(stub);
    cols.forEach((c) => tr.appendChild(el("th", null, hr.cells[c.col_index] || "")));
    thead.appendChild(tr);
  });
  table.appendChild(thead);

  const tbody = el("tbody");
  frag.rows.forEach((row) => {
    const tr = el("tr", row.kind === "category" ? "category" : "activity");
    if (row.kind === "activity" && row.parent === undefined) tr.classList.add("top-level");

    if (row.kind === "category") {
      const td = el("td", null, row.label);
      td.colSpan = cols.length + 1;
      if (row.markers) td.append(...markerNodes(row.markers));
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    const stub = el("td", "stub");
    stub.appendChild(document.createTextNode(row.label));
    stub.dataset.cell = `${frag.page}:${row.row_index}:label`;
    if (row.markers) stub.append(...markerNodes(row.markers));
    tr.appendChild(stub);

    cols.forEach((c) => {
      const cell = byCell.get(`${row.row_index}:${c.col_index}`);
      const td = el("td", "val");
      td.dataset.cell = `${frag.page}:${row.row_index}:${c.col_index}`;
      if (cell) {
        td.appendChild(document.createTextNode(cell.value));   // verbatim, never normalized
        if (cell.markers) td.append(...markerNodes(cell.markers));
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  scroll.appendChild(table);
  return scroll;
}

function markerNodes(markers) {
  return markers.map((m) => {
    const sup = el("sup", "mk", m);
    sup.dataset.marker = m;
    sup.tabIndex = 0;
    sup.title = `Footnote ${m}`;
    const go = () => highlight(m);
    sup.addEventListener("click", go);
    sup.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
    return sup;
  });
}

function notesFor(soa) {
  const list = el("div", "notes");
  soa.footnotes.forEach((n) => {
    const b = el("button", "note");
    b.dataset.note = n.marker;
    b.appendChild(el("span", "note__mk", n.marker));
    b.appendChild(el("span", "note__tx", n.text));

    const count = n.targets.length
      ? `${n.targets.length} cell${n.targets.length > 1 ? "s" : ""}`
      : n.value_cells.length
        ? `value in ${n.value_cells.length}`
        : "no target";
    const c = el("span", `note__n${n.targets.length || n.value_cells.length ? "" : " none"}`, count);
    b.appendChild(c);
    b.addEventListener("click", () => highlight(n.marker));
    list.appendChild(b);
  });
  return list;
}

/* The one interaction that matters: show what a footnote actually modifies. */
let lit = null;
function highlight(marker) {
  document.querySelectorAll(".is-lit").forEach((n) => n.classList.remove("is-lit"));
  if (lit === marker) { lit = null; return; }
  lit = marker;

  const doc = state.documents.find((d) => d.id === active);
  const soa = doc?._result?.schedules.find((s) => s.footnotes.some((f) => f.marker === marker))
    || doc?._result?.schedules.find((s) =>
      s.fragments.some((f) => f.cells.some((c) => (c.markers || []).includes(marker))));
  const note = soa?.footnotes.find((f) => f.marker === marker);

  document.querySelectorAll(`sup.mk[data-marker="${CSS.escape(marker)}"]`)
    .forEach((n) => { n.classList.add("is-lit"); n.closest("td, th")?.classList.add("is-lit"); });

  const noteEl = document.querySelector(`.note[data-note="${CSS.escape(marker)}"]`);
  if (noteEl) {
    noteEl.classList.add("is-lit");
    noteEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  // a value legend ("X = performed at this visit") modifies every cell holding that value
  (note?.value_cells || []).forEach((v) => {
    document.querySelector(`[data-cell="${v.page}:${v.row}:${v.col}"]`)?.classList.add("is-lit");
  });
}

function nearMisses(rows) {
  const dl = el("dl", "rev");
  if (!rows.length) { dl.appendChild(el("dt", null, "near misses")); dl.appendChild(el("dd", null, "none")); return dl; }
  rows.forEach((r) => {
    dl.appendChild(el("dt", null, `${r.table_id} · page ${r.page}`));
    dl.appendChild(el("dd", null, `score ${r.score} · marks ${(r.mark_share * 100).toFixed(0)}% · ${r.gate}`));
  });
  return dl;
}

function reviewBlock(r, doc) {
  const block = el("div", "block");
  const head = el("div", "block__head");
  head.appendChild(el("h2", null, "Review queue"));
  head.appendChild(el("p", null, "everything the tool was unsure about"));
  block.appendChild(head);

  const body = el("div", "block__body");
  const dl = el("dl", "rev");
  const add = (k, v, flag) => {
    dl.appendChild(el("dt", null, k));
    const dd = el("dd", null, v);
    if (flag) dd.style.color = "var(--flag)";
    dl.appendChild(dd);
  };

  const fb = r.review.footnote_blocks;
  add("footnote blocks", `${fb.accept} accepted · ${fb.review} flagged · ${fb.discard} discarded`);
  add("near-miss tables", r.review.near_miss_tables.length
    ? r.review.near_miss_tables.map((n) => `${n.table_id} p${n.page} (${n.score})`).join(", ")
    : "none", r.review.near_miss_tables.length > 0);

  r.schedules.forEach((s) => {
    const un = s.review.footnotes_never_used_in_table;
    const orph = s.review.markers_in_table_without_definition;
    add(`${s.soa_id} — footnotes with no target`, un.length ? un.join(", ") : "none", un.length > 0);
    add(`${s.soa_id} — markers with no definition`, orph.length ? orph.join(", ") : "none", orph.length > 0);
    (s.interpretation || []).forEach((i, n) => {
      add(`${s.soa_id} — interpretation ${n + 1}`,
        i.status === "ok"
          ? `${i.header_roles_applied} header roles, ${i.rows_applied} rows${i.rows_unanswered?.length ? `, ${i.rows_unanswered.length} unanswered` : ""}`
          : `${i.status}: ${i.reason}`,
        i.status === "failed");
    });
  });
  body.appendChild(dl);

  const raw = el("details", "raw");
  raw.appendChild(el("summary", null, "Structured output (JSON)"));
  const pre = el("pre", null, JSON.stringify(r, null, 2));
  raw.appendChild(pre);
  const a = el("a", "dl", `Download ${doc.name.replace(/\.pdf$/i, "")}-soa.json`);
  a.href = URL.createObjectURL(new Blob([JSON.stringify(r, null, 2)], { type: "application/json" }));
  a.download = `${doc.name.replace(/\.pdf$/i, "")}-soa.json`;
  a.style.cssText = "display:inline-block;margin-top:10px";
  raw.appendChild(a);
  body.appendChild(raw);

  block.appendChild(body);
  return block;
}

refresh();
