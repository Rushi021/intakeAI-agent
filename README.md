# Intake AI — Take-Home 1a

An agent that reads a study specification and builds it into an eSource
platform by driving the platform's own UI, with a human in the loop.

**Status: pass 1 — perception. The agent reads the page and the input file.
It does not yet modify anything.**

```
.
├── intake-agent/       the deliverable — Chrome extension (TypeScript)
│                       see intake-agent/README.md for architecture
├── intake-takehome-2/  supplied material — the eSource mock and the study IR
└── *.pdf               the assignment briefs
```

---

## Running the pipeline

Two terminals. Node 18+ for the mock, Node 22+ to run the agent's tests.

### 1 · Start the eSource platform

```bash
cd intake-takehome-2/esource-mock
npm install
npm run dev
```

Open <http://localhost:5173/>. You should land on **Visit Schedule** with an
empty visits table — that empty state is correct.

`http://localhost:5173/?reset=1` clears the study without a reload.

### 2 · Provide a Mistral API key

The agent calls **Mistral AI**, and you supply your own key. `.env` is the only
way in — there is no key field in the extension.

```bash
cd intake-agent
cp .env.example .env
```

Open `.env` and paste your key (get one at <https://console.mistral.ai> →
**API Keys**):

```dotenv
VITE_MISTRAL_API_KEY=your_key_here

# Optional — defaults to mistral-large-latest
VITE_MISTRAL_MODEL=
```

The key is read at **build time**, so `.env` must exist before step 3.
Editing it later does nothing until you re-run `npm run build` and press
**reload** ↻ on the extension card.

> **Please note.** Vite inlines the key into `dist/sidepanel.js` in plain text,
> so anyone holding the built extension folder can read it. `.env` and `dist/`
> are both in `.gitignore`, so neither is committed — `.env.example` ships blank
> and is the only one of the two in the repo. **Use a key you are willing to
> revoke, and rotate it when you are done reviewing.**

### 3 · Build and load the extension

```bash
cd intake-agent
npm install
npm run build
```

`chrome://extensions` → enable **Developer mode** → **Load unpacked** →
select `intake-agent/dist/`.

Changed `.env` afterwards? Re-run `npm run build` and hit **reload** ↻ on the
extension card — the key is baked in at build time, so an edit alone does
nothing.

### 4 · Run the agent

On the mock's tab, click the extension icon to open the side panel. It has two
tabs.

Open **Trace → Model** and click **Test connection** to confirm the key works
before a long run. That section reports the provider, the model, and whether a
key was found in `.env` — it never displays the key.

**Build** — the operator's view, two controls and nothing else:

1. Load `intake-takehome-2/data/abc-101-study.ir.json`.
2. Click **Start build**.

That is the whole interaction. The agent attaches to the tab it is looking at,
reads the page, and reports what it found. Chrome shows a *"started debugging
this browser"* banner while attached — that is expected.

**Trace** — the engineering view, for checking the agent's reasoning:

| Section | Shows |
|---|---|
| Input file | Study id and title, the six counts, and a visit → form → field tree with every type, range, coded-value count and skip rule |
| Perception | What "perceive" means here, plus the live numbers: accessibility nodes read, nodes kept, percentage dropped |
| Pruned view | Exactly what the model will be sent |
| Full detail | The expand tools — enter a `ref` and expand around it, pull dialog controls, or query nodes near coordinates |
| Model | Provider and model from `.env`, and whether a key was found. **Test connection** proves it works before a run |
| Capture options | Screenshot toggle, off by default |
| Detach debugger | Ends the session and clears the banner |

Re-read the page after navigating, saving, or opening a dialog. The Trace tab
flags a stale snapshot, but cannot catch every in-place re-render.

**Pass 1 stops after reading.** Nothing is written to the platform yet.

### 5 · Verify

```bash
cd intake-agent
npm test        # 16 checks — no browser, no network
npm run typecheck
```

The check that matters asserts that two different DOM shapes of the *same*
screen produce the same actionable surface. See
[intake-agent/README.md](intake-agent/README.md#checks).

---

## Not yet in the pipeline

Type mapping onto the platform's element library, the build and read-back loop,
the human gate queue, and the run ledger. **Start build** reads the page today;
it does not write to it.

Supplied material in `intake-takehome-2/` and the PDFs are for this assignment
only and are not redistributed.
