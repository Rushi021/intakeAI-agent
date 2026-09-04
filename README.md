# Intake AI Take-Home Assignments

Two independent parts:

- **Part 1** — [`intake-agent/`](intake-agent/) — Chrome extension that builds a study IR into an eSource platform. Architecture: [intake-agent/ARCHITECTURE.md](intake-agent/ARCHITECTURE.md)
- **Part 2** — [`intake-soa/`](intake-soa/) — extracts the Schedule of Activities from protocol PDFs. Architecture: [intake-soa/ARCHITECTURE.md](intake-soa/ARCHITECTURE.md)

Test plan and results: [TEST-PLAN.md](TEST-PLAN.md), [REPORT.md](REPORT.md)

---

## Part 1 — run the agent

**1. Start the mock eSource platform**

```bash
cd intake-takehome-2/esource-mock
npm install
npm run dev
```

Open <http://localhost:5173/>. You should land on an empty Visit Schedule.

**2. Add a Mistral API key**

```bash
cd intake-agent
cp .env.example .env
```

Open `.env` and paste your key into `VITE_MISTRAL_API_KEY` (get one at
<https://console.mistral.ai> → API Keys). The key is baked in at build time, so
set it before the next step.

**3. Build and load the extension**

```bash
npm install
npm run build
```

In Chrome: `chrome://extensions` → enable **Developer mode** → **Load
unpacked** → select `intake-agent/dist/`.

**4. Run a build**

- Click the extension icon on the mock's tab to open the side panel.
- Load `intake-takehome-2/data/abc-101-study.ir.json`.
- Click **Start build**.
- If any cards show up under "Needs a decision", answer them and click
  **Resume**.

Changed `.env`? Re-run `npm run build` and hit reload ↻ on the extension card
— the key is baked in at build time.

**Tests**

```bash
npm test
npm run typecheck
```

---

## Part 2 — run the pipeline

**1. Set up**

```bash
cd intake-soa
python3 -m venv .venv
source .venv/bin/activate            # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

First run downloads Docling's layout/table models (a few hundred MB, cached
after).

**2. Optional: Mistral API key**

Used only for the interpretation layer (header roles, row grouping). The
pipeline runs fine without it.

```bash
export MISTRAL_API_KEY=...
```

If `intake-agent/.env` already has a key from Part 1, it's picked up
automatically — no need to set this twice.

**3. Run the UI**

```bash
python -m soa.server
```

Open <http://127.0.0.1:8000>, drag in one or more protocol PDFs, press **Run
agent**. Run history for both parts of this assignment is at
<http://127.0.0.1:8000/runs.html>.

**4. Or run headless**

```bash
python run_corpus.py                 # every PDF in ../takehome-1b/
python run_corpus.py protocol9       # one document
python run_corpus.py --no-model      # rules only, no API key needed
python test_soa.py                   # smoke check, seconds, no PDF conversion
```

Protocol PDFs need to exist locally in `takehome-1b/` for the headless
scripts. The UI accepts any upload.

**5. Extractor Agent Result — the five submitted outputs**

A separate Streamlit page, showing the required deliverable directly: the
Schedule of Activities extracted from each of the five supplied protocols,
read straight from the committed `outputs/*-soa.json` files (produced by
`run_corpus.py`, not re-run live).

```bash
pip install streamlit    # already in requirements.txt
streamlit run streamlit_app.py
```

---

Supplied material in `intake-takehome-2/` and the protocol PDFs are for this
assignment only and are not redistributed.
