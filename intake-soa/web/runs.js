/* Run log. Read-only view over outputs/runs.db — a record of what happened, never a way to
   change it. The two parts of the assignment share one row shape (produced / expected / flagged),
   so one table renders both and the header just counts them separately. */

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

let all = [];
let part = "";            // "" = every part

const PARTS = { soa: "SoA extraction", agent: "Study build" };
const label = (p) => PARTS[p] || p;
const when = (iso) => new Date(iso).toLocaleString();

async function load() {
  let data;
  try {
    const res = await fetch("/api/runs");
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    data = await res.json();
  } catch (e) {
    $("panel").replaceChildren(el("div", "err", `Could not read the run log: ${e.message}`));
    return;
  }
  all = data.runs;
  renderTotals(data.totals);
  renderFilters();
  render();
}

function renderTotals(totals) {
  const box = $("totals");
  box.replaceChildren();
  if (!totals.length) { box.append(el("p", "rail__note", "No runs recorded yet.")); return; }
  for (const t of totals) {
    const d = el("div", "doc");
    d.dataset.status = t.not_done ? "failed" : "done";
    d.append(el("div", "doc__name", label(t.part)));
    const bits = [`${t.runs} run${t.runs === 1 ? "" : "s"}`];
    if (t.expected) bits.push(`${t.produced}/${t.expected} produced`);
    else if (t.produced != null) bits.push(`${t.produced} produced`);
    if (t.flagged != null) bits.push(`${t.flagged} flagged`);
    if (t.avg_seconds != null) bits.push(`${t.avg_seconds}s avg`);
    if (t.not_done) bits.push(`${t.not_done} not done`);
    d.append(el("div", "doc__meta", bits.join(" · ")));
    box.append(d);
  }
}

function renderFilters() {
  const box = $("filters");
  box.replaceChildren();
  const parts = ["", ...new Set(all.map((r) => r.part))];
  for (const p of parts) {
    const b = el("button", `tab${p === part ? " on" : ""}`, p ? label(p) : "Everything");
    b.setAttribute("aria-selected", String(p === part));
    b.addEventListener("click", () => { part = p; renderFilters(); render(); });
    box.append(b);
  }
}

/** How much of what was asked for came out. Blank when the run had no target to compare against. */
function recall(r) {
  if (!r.expected) return r.produced == null ? "—" : String(r.produced);
  return `${r.produced}/${r.expected} · ${Math.round((r.produced / r.expected) * 100)}%`;
}

function render() {
  const rows = part ? all.filter((r) => r.part === part) : all;
  $("head").textContent = rows.length
    ? `${rows.length} run${rows.length === 1 ? "" : "s"}${part ? ` · ${label(part)}` : ""}`
    : "No runs";

  const panel = $("panel");
  panel.replaceChildren();
  if (!rows.length) {
    const e = el("div", "empty");
    e.append(el("b", null, "Nothing recorded yet"),
             el("span", null, "Extract a protocol, or ingest an agent bench run, then reload."));
    panel.append(e);
    return;
  }
  for (const r of rows) panel.append(runBlock(r));
}

function runBlock(r) {
  const block = el("div", "block");

  const head = el("div", "block__head");
  const h = el("h2", null, r.subject);
  head.append(h);
  const meta = el("p", null,
    [label(r.part), r.input, when(r.started), r.seconds != null ? `${r.seconds}s` : null]
      .filter(Boolean).join(" · "));
  head.append(meta);
  head.append(el("span", `pill pill--${r.status === "done" ? (r.flagged ? "info" : "ok") : "flag"}`,
    r.status === "done" && r.flagged ? `${r.flagged} need a person` : r.status));
  block.append(head);

  const body = el("div", "block__body");
  const dl = el("dl", "rev");
  const add = (k, v, flag) => {
    dl.append(el("dt", null, k));
    const dd = el("dd", null, v);
    if (flag) dd.style.color = "var(--flag)";
    dl.append(dd);
  };

  add(r.part === "agent" ? "fields built" : "schedules found", recall(r),
      !!r.expected && r.produced < r.expected);
  add("needs a person", String(r.flagged ?? 0), (r.flagged ?? 0) > 0);

  const d = r.detail || {};
  if (r.part === "agent") {
    if (d.visits) add("visits", d.visits, d.visits.split("/")[0] !== d.visits.split("/")[1]);
    if (d.forms) add("forms", d.forms, d.forms.split("/")[0] !== d.forms.split("/")[1]);
    if (d.panel_status) add("agent reported", d.panel_status);
    if (d.ledger_states) add("ledger", Object.entries(d.ledger_states).map(([k, n]) => `${k} ${n}`).join(" · "));
  } else {
    const doc = d.document || {};
    if (doc.pages) add("document", `${doc.pages} pages · ${doc.tables} tables · ${doc.convert_seconds}s to convert`);
    if (d.model) add("model", d.model);
    for (const s of d.schedules || []) {
      add(`${s.soa_id}`, `pages ${(s.pages || []).join(", ")} · ${s.fragments} fragment(s) · ${s.footnotes} footnote(s)`);
      const un = s.review?.footnotes_never_used_in_table || [];
      const orph = s.review?.markers_in_table_without_definition || [];
      if (un.length) add(`${s.soa_id} — footnotes with no target`, un.join(", "), true);
      if (orph.length) add(`${s.soa_id} — markers with no definition`, orph.join(", "), true);
    }
    if (d.error) add("error", d.error, true);
  }
  body.append(dl);

  // The escalated path, spelled out: what the agent was blocked on, what it already tried, and
  // how many plan items each card is holding up. This is what a person acts on.
  for (const c of d.gate_cards || []) {
    const card = el("details", "raw");
    card.append(el("summary", null, `${c.signature} — ${c.question}`));
    const pre = el("pre", null, [c.blocks, c.tried].filter(Boolean).join("\n\n") || "—");
    card.append(pre);
    body.append(card);
  }

  const raw = el("details", "raw");
  raw.append(el("summary", null, "Everything recorded for this run (JSON)"));
  raw.append(el("pre", null, JSON.stringify(r, null, 2)));
  body.append(raw);

  block.append(body);
  return block;
}

load();
