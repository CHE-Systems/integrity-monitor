# CHE Data Integrity Monitor

AI-driven monitoring pipeline that keeps Airtable enrollment data accurate for Students, Parents, Contractors, Classes, Attendance, Truth, and campus entities. KPI 1 targets 90%+ automatic anomaly detection with a leadership-facing Data Health dashboard running by **January 1, 2026** and weekly-or-better scan cadence.

## Repository Structure

| Path            | Description                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend/`      | FastAPI service that will host the integrity checks, integrate with Airtable via `pyairtable`, and write anomalies back to Airtable + Firestore.        |
| `frontend/`     | React + TypeScript + Vite dashboard (Tailwind styling) that surfaces run status, anomaly metrics, and guided fixes.                                     |
| `context.md`    | Living project brief that records decisions, assumptions, completions, and integration notes.                                                           |
| `prompts.md`    | Queue of outstanding AI prompt tasks. Complete prompts get removed here and summarized inside `context.md`.                                             |
| `docs/rules.md` | **CRITICAL:** Complete implementation guide for creating and maintaining integrity rules. Must be consulted before implementing or modifying any rules. |

## Backend (FastAPI)

- Entrypoint: `backend/main.py`
- Dependencies: `backend/requirements.txt` (FastAPI, uvicorn; add `pyairtable`, Google/Firebase SDKs, etc. as implementation progresses).
- Expected responsibilities (per Airtable Integration Guidelines):
  - Fetch Airtable data using config-driven table + field IDs.
  - Run duplicate detection, link consistency, required field, and attendance anomaly checks.
  - Write structured issues to Airtable `Data Issues` table and mirrored summaries into Firestore (`integrity_runs`, `integrity_metrics_daily`, optional `integrity_issues`).
  - Serve a secured `POST /integrity/run` endpoint for Cloud Scheduler → Cloud Run jobs, plus lightweight health endpoints (`/health` ready today).
- Config scaffolding now lives under `backend/config/`:
  - Rules are managed in Firestore only. The `schema.yaml` file has been removed. Use the Rules UI or API to manage rules.
  - `schema_loader.py` (with Pydantic models in `models.py`) lets the backend load strongly typed configs. `/schema` endpoint currently dumps the config for dev validation.
  - `rules.yaml` + `config_loader.py`/`settings.py` capture runtime scheduling + Airtable/Firestore mapping described in `docs/prompt-2-architecture-plan.md`, plus attendance thresholds from `docs/prompt-5-attendance-rules.md`.
- Service layout created per prompt 2:
  - `clients/` – Airtable + Firestore wrappers (stubs for now).
  - `fetchers/` – entity fetcher registry built atop the Airtable client.
  - `checks/` – duplicates module implements fuzzy logic + grouping from `docs/prompt-3-duplicate-spec.md`; link + required-field modules enforce `docs/prompt-4-link-rules.md`; attendance module codifies metrics from `docs/prompt-5-attendance-rules.md`.
  - `analyzers/` – merges issue payloads and computes summary counts.
  - `writers/` – stub writers for Airtable issues + Firestore summaries.
  - `services/integrity_runner.py` – orchestrates the full run, called by `POST /integrity/run`.
- Frontend dashboard (`frontend/src/App.tsx`) now reflects the layout + drill-down behavior captured in `docs/prompt-7-dashboard-spec.md` with hero, KPI cards, trend charts, severity donut, issue queues, runs table, and drill-down list.
- Automation/QA hooks per `docs/prompt-8-automation-qa.md`: run stages timed via `utils/timing.py`, Firestore writer logs metadata, and `pytest.ini` + `tests/` scaffolding prepare for fixtures/regression suites.

### Local development

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload
```

Environment variables (API keys, base IDs, Firestore creds) should be stored in a `.env` or injected secrets—never committed.

## Frontend (React/Vite)

- Located in `frontend/`; current UI showcases the Data Health dashboard look-and-feel with placeholder metrics and cards.
- Will ultimately fetch run summaries + metrics from Firestore (via Firebase SDK) and expose drill-downs into Airtable issue lists.

### Local development

```bash
cd frontend
npm install
npm run dev
```

Configure Firebase + API base URLs via Vite env files when integrating real data (`.env`, `VITE_*`).

## Cloud Architecture

1. **FastAPI backend → Cloud Run** container. Hosts `/integrity/run` and Airtable interactions. Sole Airtable client.
2. **Cloud Scheduler** triggers the backend nightly/weekly with service account auth.
3. **Airtable** remains source of truth; use Data Issues table with rule IDs to avoid duplicate entries; optionally flag originating records.
4. **Firestore** stores run metadata (`integrity_runs`), aggregated trend metrics (`integrity_metrics_daily`), optional fast-query issue mirror, and access control via `users/{uid}`.
5. **Firebase Hosting + React dashboard** authenticated via Firebase Auth, reads Firestore docs, optionally calls backend for re-runs.

## Deployment

### Prerequisites

- Google Cloud Project with billing enabled
- Artifact Registry repository created
- Secret Manager configured with all required secrets (see `pending-env.md`)
- `gcloud` CLI installed and authenticated

### Quick Start

1. **Set environment variables:**

   ```bash
   export GCP_PROJECT_ID="your-project-id"
   export CLOUD_RUN_REGION="us-central1"
   ```

2. **Set up IAM:**

   ```bash
   ./deploy/iam-setup.sh prod
   ```

3. **Deploy service:**

   ```bash
   ./deploy/deploy.sh prod
   ```

4. **Create scheduler jobs:**

   ```bash
   ./deploy/create-scheduler.sh prod
   ```

5. **Set up monitoring:**
   ```bash
   export SLACK_WEBHOOK_URL="https://hooks.slack.com/..."
   export ALERT_EMAIL="ops@example.com"
   ./deploy/create-alerts.sh prod
   ```

### Deployment Files

- `deploy/cloudbuild.yaml` - Cloud Build configuration
- `deploy/deploy.sh` - Manual deployment script
- `deploy/create-scheduler.sh` - Cloud Scheduler job setup
- `deploy/create-alerts.sh` - Monitoring alert policies
- `deploy/iam-setup.sh` - Service account and IAM configuration

### Service Configuration

- **Memory:** 1GB
- **CPU:** 1
- **Timeout:** 15 minutes
- **Min instances:** 0 (scales to zero)
- **Max instances:** 10 (prod)

### Scheduler Jobs

- **integrity-nightly:** Runs daily at 02:00 AM (incremental mode)
- **integrity-weekly:** Runs Sunday at 03:00 AM (full mode)

Both jobs retry up to 3 times with exponential backoff.

For detailed operations guide, see `docs/runbook.md`.

**Important Documentation:**

- `docs/rules.md` - **CRITICAL:** Complete guide for implementing and maintaining integrity rules. Always reference this when creating or modifying rules.
- `context.md` - Evolving implementation notes, decisions, and deliverable log.

## Working With AI Prompts

- `prompts.md` tracks every outstanding AI design or planning prompt as an actionable TODO list.
- When a prompt is executed, remove it from `prompts.md` and document the produced artifacts/decisions inside `context.md` so future agents know what changed.

## Next Steps

1. Process the prompts in `prompts.md` starting with Schema & Anomaly Definitions.
2. Flesh out backend modules per the upcoming design prompts.
3. Wire the frontend to Firestore mock data, then real backend endpoints.
4. Stand up CI/CD plus Cloud Run + Scheduler deployment scripts once architecture decisions are finalized.

Always keep the KPI targets (90%+ automated anomaly identification, weekly scans, dashboard live by Jan 1 2026) visible in planning and testing.
