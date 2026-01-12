# Context – CHE Data Integrity Monitor

Last updated: 2026-01-09 (Scheduled scan rule selection fix; deployment hardening)

## Mission & KPI 1

- Build and deploy an AI-powered Airtable data monitor that automatically identifies 90%+ of data anomalies (duplicates, missing links, attendance issues) and keeps a leadership-facing Data Health dashboard live by **Jan 1, 2026**.
- Data checks must run at least weekly; bonus is awarded upon delivery of target deliverables.

## Current State (2025-01-27 - Automation, QA, and KPI Measurement Complete)

- **Backend:** Fully implemented check modules (duplicates, links, required fields, attendance), integrity runner, config loaders, and API endpoints. Integrity metrics service added with endpoints for summary, runs, trends, queues, derived metrics, flagged rules, and KPI. Airtable schema service provides schema snapshots. Config loader supports env() placeholders, Firestore overrides, and config version tracking. Structured JSON logging implemented with stage-specific helpers. Execution safeguards added: rate limiting/retries in AirtableClient, chunked writes in airtable_writer. Incremental fetching implemented using lastModifiedTime filtering. Issues written to Firestore `integrity_issues` collection. Feedback analyzer service analyzes ignored issues and flags rules exceeding 10% threshold. KPI sampler service generates weekly samples and calculates 90%+ anomaly detection KPI. **Rules are managed in Firestore only** - loaded via RulesService at runtime. The `schema.yaml` file has been removed to eliminate YAML/Firestore conflicts. Airtable/Firestore clients scaffolded but need production credentials.
- **Frontend:** Dashboard UI complete with full integration. Firebase SDK integrated with Auth and Firestore hooks. `useIntegrityMetrics` refactored to use Firestore real-time subscriptions and includes flagged rules and KPI data. App wrapped with AuthGuard (authentication + admin check) and ErrorBoundary. All interactive features implemented: "Run scan" button triggers backend runs with toast notifications, issue queue cards are clickable and show filtered IssueList, run history items open RunDetailModal, issue drill-down table shows real Firestore data via IssueList component, Airtable deep links functional. "Most Ignored Rules" widget displays flagged rules. KPI measurement card shows percentage, trend chart, and alerts. Toast notification system for user feedback. All components integrated and functional.
- **Airtable Integration:** Schema discovery scripts created (`airtable_tables_overview.py`, `airtable_fields_overview.py`, `airtable_records_snapshot.py`). Full schema snapshot generated (`backend/config/airtable_schema.json`) with 67 tables, 2304 fields, 85613 records.
- **Local Development:** `run.sh` and `stop.sh` scripts added for spinning up backend and frontend simultaneously.
- **Automation:** Cloud Scheduler scripts created (`deploy/create-scheduler.sh`) with nightly (02:00 AM), weekly (Sunday 03:00 AM), and KPI sampling (Sunday 04:00 AM) jobs. Alert scripts created (`deploy/create-alerts.sh`) for Cloud Monitoring. Deployment configs ready (`cloudbuild.yaml`, `Dockerfile`). Manual run button functional in dashboard.
- **QA & Testing:** Complete test suite implemented. Test infrastructure created (`backend/tests/` with `conftest.py` and fixtures). Unit tests for normalization, similarity, duplicates, links, attendance, required_fields. Integration tests for IntegrityRunner with mocked clients. Regression tests comparing outputs to golden files. Test dependencies added (`pytest`, `pytest-mock`, `responses`).
- **Production:** No deployments yet. Airtable + Firestore credentials/config to live in env/secrets.

## Architecture & Integration Guardrails

1. **Data sources**
   - Airtable is the canonical store for Students, Parents, Contractors, Classes, Attendance, Truth, etc., plus a dedicated `Data Issues` table for anomalies.
   - Firestore keeps run metadata (`integrity_runs`), aggregated metrics (`integrity_metrics_daily`), optional `integrity_issues` mirror, user roles, and **all data integrity rules** (duplicates, relationships, required fields, value checks).
2. **Backend responsibilities**
   - Python/FastAPI app (deployed to Cloud Run) fetches Airtable data via `pyairtable`, runs duplicate/link/attendance checks, writes issues to Airtable & Firestore, and exposes a secured `POST /integrity/run`.
   - Config module maps logical entities → `{base_id, table_id, key_fields}` to avoid hard-coded IDs. API secrets live in env/Secret Manager.
   - **Rules are managed in Firestore only** - loaded via `RulesService` at runtime. The `schema.yaml` file has been removed to eliminate YAML/Firestore conflicts.
3. **Automation**
   - Cloud Scheduler triggers `/integrity/run` nightly/weekly using a service account.
   - Backend writes run summaries + metrics, supports incremental scans via `lastModifiedTime`, and upserts issues using stable `(rule_id, record_id)` keys.
4. **Frontend**
   - Firebase Hosting + React/Tailwind SPA, authenticated via Firebase Auth.
   - Reads run status + metrics from Firestore, optionally mirrors issues for fast filtering, and can trigger on-demand scans through rewrite to Cloud Run (`/api/integrity/run`).

## Working Agreements

- `prompts.md` stores the queue of **unrun** AI prompt tasks; completed prompts must be removed from that file and summarized here along with produced artifacts (links, file paths, configs).
- Comments and docs use ASCII; secrets/configs remain out of version control.
- Use Airtable as the source of truth and keep Firestore optimized for dashboard consumption.
- Always align implementations with `ChatGPT_Master_Prompt.md` (ContextPrime) plus CHE design documents (`CHE_IMPLEMENTATION_GUIDE.md`, `CHE_STYLE_GUIDE.md`) for tone, role expectations, and UI styling.
- Environment variable setup tasks live in `pending-env.md`; keep it concise and up to date.
- **CRITICAL: Always reference `docs/rules.md` when implementing or modifying rules.** This guide contains essential information about field reference formats (IDs vs names), schema snapshot requirements, rule storage structure, best practices, and troubleshooting. The field ID/name resolution system must be understood before creating or updating any rules.
- **Rules are managed in Firestore only** - Use the Rules UI or API to create, edit, and delete rules. The `schema.yaml` file has been removed. A snapshot tool (`backend/scripts/migrate_rules.py`) is available for creating read-only backups of Firestore rules to YAML format.

## Deliverable Log

| Date       | Deliverable                        | Details / Location                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2025-11-19 | Schema & anomaly spec              | `docs/prompt-1-schema-spec.md` – entity list, duplicate/missing-link definitions, key-data rules.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 2025-11-19 | Architecture & scheduling plan     | `docs/prompt-2-architecture-plan.md` – FastAPI→Cloud Run design, config strategy, schedules, anomaly storage schema.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 2025-11-19 | Duplicate detection spec           | `docs/prompt-3-duplicate-spec.md` – per-entity rules, fuzzy approach, thresholds, data model, pseudo-code.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 2025-11-19 | Link & required-field rules        | `docs/prompt-4-link-rules.md` – human-readable relationship rules. Rules are now managed in Firestore only (YAML format was used historically but has been removed).                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 2025-11-19 | Attendance anomaly rules           | `docs/prompt-5-attendance-rules.md` – excessive absence thresholds, severity model, schema, pseudo-code, config.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 2025-11-19 | Job flow & config layout           | `docs/prompt-6-job-flow.md` – backend module tree, execution flow, config structure, logging/metrics plan (implemented via `services/integrity_runner.py`, timing utils, Firestore summaries).                                                                                                                                                                                                                                                                                                                                                                                                |
| 2025-11-19 | Dashboard layout & metrics         | `docs/prompt-7-dashboard-spec.md` + `frontend/src/App.tsx` – UI layout, metrics catalog, drill-down behavior, component outline.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 2025-11-19 | Automation & QA plan               | `docs/prompt-8-automation-qa.md` – schedules, alerts, QA/testing approach, KPI measurement.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 2025-11-19 | Schema config implementation       | Rules are managed in Firestore only. Schema loader reads from Firestore via RulesService. The `schema.yaml` file has been removed.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 2025-11-19 | Architecture scaffolding           | Backend directories (`clients/`, `fetchers/`, `checks/`, `writers/`, `services/`) + `rules.yaml`, `/integrity/run` endpoint match prompt 2 design.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 2025-11-19 | Duplicate detection implementation | `backend/checks/duplicates.py` – normalized records, fuzzy matching, grouping per prompt-3 spec.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 2025-11-19 | Link & required field checks       | `backend/checks/links.py`, `backend/checks/required_fields.py` – config-driven validations from prompt-4 spec.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 2025-11-19 | Attendance anomaly implementation  | `backend/checks/attendance.py` + `attendance_rules` in `config/rules.yaml` – metrics per prompt-5 spec.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2025-11-19 | Integrity runner implementation    | `backend/services/integrity_runner.py` – orchestrates fetch, checks, write per prompt-6 spec.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 2025-11-19 | **Prompts 1-6 completed**          | All design specs implemented. See `prompts.md` for remaining tasks.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 2025-11-20 | Airtable schema discovery          | Scripts created: `backend/scripts/airtable_tables_overview.py`, `airtable_fields_overview.py`, `airtable_records_snapshot.py`. Full schema snapshot generated with 67 tables, 2304 fields, 85613 records.                                                                                                                                                                                                                                                                                                                                                                                     |
| 2025-11-20 | Integrity metrics service          | `backend/services/integrity_metrics_service.py` – aggregates issue counts, calculates derived metrics (completeness, link health, duplicate rate), groups issues into queues.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 2025-11-20 | Metrics API endpoints              | Added 5 endpoints to `backend/main.py`: `/integrity/metrics/summary`, `/runs`, `/trends`, `/queues`, `/derived`. Handle missing Firestore data gracefully.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 2025-11-20 | Dashboard real metrics integration | `frontend/src/hooks/useIntegrityMetrics.ts` – centralized data fetching. `frontend/src/App.tsx` updated to replace all placeholder data with real API data. Error handling and fallbacks implemented.                                                                                                                                                                                                                                                                                                                                                                                         |
| 2025-11-20 | Local development scripts          | `run.sh` and `stop.sh` – spin up/kill both backend and frontend for local development.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 2025-11-20 | Pydantic v2 compatibility          | Updated `backend/config/settings.py` to use `RootModel` instead of deprecated `__root__` syntax.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 2025-01-XX | Firebase SDK setup                 | Added `firebase` package to `frontend/package.json`. Created `frontend/src/config/firebase.ts` with Firebase app initialization, auth, and Firestore exports. Created `frontend/.env.example` with Firebase config template.                                                                                                                                                                                                                                                                                                                                                                  |
| 2025-01-XX | Firebase Auth integration          | Created `frontend/src/hooks/useAuth.ts` – authentication hook with email/password and Google sign-in, admin status check via Firestore `users/{uid}.isAdmin`. Created `frontend/src/components/AuthGuard.tsx` – wrapper component requiring authentication and optional admin access.                                                                                                                                                                                                                                                                                                         |
| 2025-01-XX | Firestore data hooks               | Created `frontend/src/hooks/useFirestoreRuns.ts` – real-time subscription to `integrity_runs` collection. Created `frontend/src/hooks/useFirestoreMetrics.ts` – subscription to `integrity_metrics_daily` for trends and severity counts. Created `frontend/src/hooks/useFirestoreIssues.ts` – queryable issues with filtering, search, pagination.                                                                                                                                                                                                                                           |
| 2025-01-XX | Metrics hook refactor              | Refactored `frontend/src/hooks/useIntegrityMetrics.ts` to use Firestore hooks instead of REST API. Now uses `useFirestoreRuns` and `useFirestoreMetrics` for real-time data. Calculates summary from latest run, builds issue queues from Firestore `integrity_issues` collection.                                                                                                                                                                                                                                                                                                            |
| 2025-01-XX | UI components                      | Created `frontend/src/components/Toast.tsx` – toast notification system. Created `frontend/src/components/ErrorBoundary.tsx` – React error boundary. Created `frontend/src/components/RunDetailModal.tsx` – modal showing run metadata and per-rule breakdown. Created `frontend/src/components/IssueList.tsx` – filterable issue table with Airtable links and resolve actions. Created `frontend/src/components/MetricCard.tsx` – reusable metric card component.                                                                                                                           |
| 2025-01-XX | Airtable integration utilities     | Created `frontend/src/utils/airtable.ts` – functions for generating Airtable deep links (`getAirtableRecordLink`, `getAirtableLinkByEntity`, `getDataIssuesLink`). Supports entity-based mapping via environment variables.                                                                                                                                                                                                                                                                                                                                                                   |
| 2025-01-XX | Issue actions hook                 | Created `frontend/src/hooks/useIssueActions.ts` – `markResolved` and `markIgnored` functions that update Firestore `integrity_issues` collection with status, timestamps, and resolution notes.                                                                                                                                                                                                                                                                                                                                                                                               |
| 2025-01-27 | Config loader enhancements         | Enhanced `backend/config/config_loader.py` – added env() placeholder resolution in YAML, Firestore override merging from `integrity_config/current` document, config version/checksum tracking (SHA256). Updated `integrity_runner.py` to load config with Firestore client for overrides.                                                                                                                                                                                                                                                                                                    |
| 2025-01-27 | Structured JSON logging            | Implemented JSON formatter in `backend/clients/logging.py` with stage-specific helpers (`log_config_load`, `log_fetch`, `log_check`, `log_write`). Updated `integrity_runner.py` to use structured logging for all stages with `run_id`, `stage`, `duration_ms` context.                                                                                                                                                                                                                                                                                                                      |
| 2025-01-27 | Metrics enhancements               | Added `trigger` field (nightly/weekly/manual) to run metadata. Added `config_version` to run metadata and Firestore documents. Enhanced `backend/analyzers/scorer.py` to track `duplicate_groups_formed` count and attendance anomalies by metric type. Updated `/integrity/run` endpoint to accept `trigger` parameter.                                                                                                                                                                                                                                                                      |
| 2025-01-27 | Execution safeguards               | Added rate limiting and retries to `backend/clients/airtable.py` using `tenacity` library with exponential backoff for 429 errors. Implemented request throttling (5 req/s per base). Implemented chunked writes in `backend/writers/airtable_writer.py` (batches of 10) to avoid HTTP 413 errors. Added `tenacity>=8.2.3` to `requirements.txt`.                                                                                                                                                                                                                                             |
| 2025-01-27 | Incremental fetching               | Added `get_last_successful_run_timestamp()` method to `backend/clients/firestore.py`. Updated `AirtableClient.fetch_records()` and `BaseFetcher.fetch()` to accept `datetime` for `incremental_since`. Updated `integrity_runner._fetch_records()` to use incremental fetching when `mode == "incremental"` based on last successful run timestamp. Added logging for incremental vs full scan decisions.                                                                                                                                                                                     |
| 2025-01-27 | Dashboard App.tsx integration      | Updated `frontend/src/App.tsx` to wrap with `AuthGuard` and `ErrorBoundary` in `main.tsx`. Added toast notification system with state management. Implemented "Run scan" button handler with POST to `/integrity/run` endpoint using Firebase auth token. Made issue queue cards clickable to show filtered `IssueList` component. Replaced placeholder issue table with real `IssueList` component. Made run history items clickable to show `RunDetailModal`. Added Airtable deep links to "View in Airtable" buttons using `getDataIssuesLink()`. All interactive features now functional. |
| 2025-01-27 | Issues written to Firestore        | Added `write_issues()` method to `backend/writers/firestore_writer.py` and `record_issues()` to `backend/clients/firestore.py`. Issues now persisted to `integrity_issues` collection with `rule_id + record_id` as document ID for deduplication. Integrated into `integrity_runner.py` after writing run summary.                                                                                                                                                                                                                                                                           |
| 2025-01-27 | Test infrastructure                | Created `backend/tests/` directory structure with `conftest.py` for shared fixtures. Added test fixtures: `tests/fixtures/students.json`, `parents.json`, `attendance.json`, and `golden/` directory for regression tests. Added test dependencies to `requirements.txt`: `pytest>=7.4.0`, `pytest-mock>=3.12.0`, `responses>=0.24.0`.                                                                                                                                                                                                                                                        |
| 2025-01-27 | Unit tests                         | Created unit tests: `test_normalization.py` (name/phone normalization), `test_similarity.py` (Jaro-Winkler, Jaccard), `test_duplicates.py` (duplicate detection logic), `test_links.py` (link validation), `test_required_fields.py` (field requirements), `test_attendance.py` (attendance anomaly detection). All tests use fixtures and cover core functionality.                                                                                                                                                                                                                          |
| 2025-01-27 | Integration & regression tests     | Created `test_integrity_runner.py` – integration tests with mocked Airtable/Firestore clients testing full run flow. Created `test_regression.py` – regression tests comparing fixture outputs to golden files, auto-creates golden files on first run.                                                                                                                                                                                                                                                                                                                                       |
| 2025-01-27 | Feedback analyzer service          | Created `backend/services/feedback_analyzer.py` – analyzes ignored issues from Firestore, calculates ignored percentage per rule, flags rules exceeding 10% threshold. Stores flagged rules in `integrity_flagged_rules` collection. Integrated into nightly runs in `integrity_runner.py`. Added `record_flagged_rule()` to FirestoreClient.                                                                                                                                                                                                                                                 |
| 2025-01-27 | Flagged rules endpoint & widget    | Added `GET /integrity/metrics/flagged-rules` endpoint in `backend/main.py`. Added `get_flagged_rules()` method to `IntegrityMetricsService`. Updated `frontend/src/hooks/useIntegrityMetrics.ts` to fetch flagged rules. Added "Most Ignored Rules" widget to `frontend/src/App.tsx` showing top 5 flagged rules with ignored percentages.                                                                                                                                                                                                                                                    |
| 2025-01-27 | KPI sampler service                | Created `backend/services/kpi_sampler.py` – generates weekly samples (100 records per entity), calculates KPI from reviewer labels vs monitor detections (true_positives / (true_positives + false_negatives)), stores samples in `integrity_kpi_samples` collection. Auto-creates review tasks in `integrity_review_tasks` when KPI < 90%. Added `record_kpi_sample()` to FirestoreClient.                                                                                                                                                                                                   |
| 2025-01-27 | KPI endpoints & dashboard          | Added `GET /integrity/metrics/kpi` endpoint returning latest KPI, 8-week trend, and alerts. Added `POST /integrity/kpi/sample` endpoint for scheduler to trigger weekly sampling. Updated `frontend/src/hooks/useIntegrityMetrics.ts` to fetch KPI data. Added KPI measurement card to `frontend/src/App.tsx` showing percentage, trend chart, target status, and alerts.                                                                                                                                                                                                                     |
| 2025-01-27 | KPI scheduler job                  | Added weekly KPI sampling job to `deploy/create-scheduler.sh` – runs Sunday 04:00 AM (after weekly full scan at 03:00 AM). Job calls `/integrity/kpi/sample` endpoint.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 2025-01-27 | Runbook documentation              | Updated `docs/runbook.md` with QA process (pre-release checklist, test structure, golden file updates), KPI measurement workflow (weekly sampling, manual calculation, review process), and rule tuning via Firestore (threshold adjustments, flagged rules review, best practices).                                                                                                                                                                                                                                                                                                          |
| 2025-01-XX | CORS and 500 error fixes           | Fixed CORS policy errors and 500 Internal Server Error on `/airtable/schema` endpoint. See archived troubleshooting section.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 2025-12-26 | Rule selection bug fix             | Fixed critical bug where selecting individual rules caused ALL rules in that category to execute. Root cause: double-nested `run_config` in frontend request body. Fixed by sending `runConfig` directly as body instead of `{run_config: runConfig}`. Also fixed indentation bugs and removed duplicate `else` blocks in filtering logic. See `context-rules-fix.md` for complete debugging journey.                                                                                                                                                                                         |
| 2026-01-07 | School year filtering system       | Implemented centralized school year filtering to prevent fetching outdated records. Created `backend/services/school_year_service.py` that fetches current/upcoming years from external API (toolkit.che.systems), determines active years based on transition period (Feb 1-Aug 5: both years; Aug 6-Jan 31: current only), and caches in Firestore. Added `school_year` config section to `rules.yaml` with per-entity field mappings and filter types (exact/contains). Updated `AirtableClient.build_school_year_filter()` to generate Airtable formulas. Modified `BaseFetcher` to automatically apply filtering. Integrated into `IntegrityRunner`. Added API endpoints: `GET /admin/school-years/current`, `POST /admin/school-years/refresh`. Uses `TOOLKIT_API_KEY` from Google Cloud Secret Manager. |
| 2026-01-08 | School year filtering fixes        | **Critical fix** for comma-separated school years causing student count discrepancy (1807 vs 2860 expected). Changed all entities from exact equality (`=`) to substring search (`FIND()`) with `contains_or_empty` filter type to handle Students with multiple years like "2023-2024, 2024-2025, 2025-2026". Removed transition period logic - now always includes current + 3 future years (e.g., ["2025-2026", "2026-2027", "2027-2028", "2028-2029"]) fetched from external API. Added `_generate_future_years()` method for programmatic year generation. Fixed `ISBLANK()` error by using `NOT()` for empty value checking (Airtable doesn't support ISBLANK). Added real-time logging showing exact filter formula and record counts. Final formula example: `OR(FIND('2025-2026', {School Year Text}), FIND('2026-2027', {School Year Text}), FIND('2027-2028', {School Year Text}), FIND('2028-2029', {School Year Text}), NOT({School Year Text}))`. Files modified: `backend/services/school_year_service.py` (removed transition logic, added programmatic generation), `backend/clients/airtable.py` (added 4 filter types with NOT for empty values, added real-time logging), `backend/config/rules.yaml` (changed all entities to `contains_or_empty`), `backend/fetchers/base.py` (added filter formula logging). Result: Now fetching expected ~2860 students instead of 1807. |
| 2026-01-09 | Scheduled scans rule selection fix | Scheduled runs were not applying selected rules because the scheduled trigger request reached Cloud Run with an empty body (`content-length: 0`), resulting in `run_config=None`. Fixed by ensuring Firebase scheduled function always sends a serialized JSON body and explicit `Content-Length`, and hardening backend to parse raw body via `await request.body()`. Full details: `SCHEDULED-SCANS-RULE-SELECTION-FIX.md`. |

Update this table as prompts are completed or additional context emerges.

## Recent Fixes

### Duplicate Check Execution Bug Fix (2025-01-27)

**Issue:** Duplicate scans were running even when not selected in the scan configuration. When users selected only required field rules, the duplicates check would still execute, causing unnecessary processing and potentially returning unwanted duplicate issues.

**What We Tried (That Didn't Work):**

1. **Backend default logic fix** - Initially, we modified `backend/services/integrity_runner.py` to check `run_config.get("checks", {}).get("duplicates")` and default to `False` if missing. This didn't work because the `checks` field wasn't being sent from the frontend at all.

2. **Frontend checks calculation** - The `ScanConfigModal` was correctly building `effectiveChecks` based on selected rules, but this wasn't being included in the request body sent to the backend.

3. **Single code path assumption** - We initially only fixed `frontend/src/App.tsx`, assuming all scans went through that path. However, `frontend/src/pages/RunsPage.tsx` had a separate `executeScan` function that also needed fixing.

**Root Cause:**

The issue had two parts:

1. **Missing `checks` field in request body** - Both `App.tsx` and `RunsPage.tsx` were building `runConfig` with `entities` and `rules`, but not including the `checks` field that the modal was sending. The backend's `IntegrityRunner` was defaulting to `should_run_duplicates = True` when the `checks` key was missing.

2. **Incorrect request body structure in RunsPage** - `RunsPage.tsx` was wrapping `runConfig` in `{ run_config: runConfig }`, but FastAPI's `Body(default=None)` expects the body to be the dictionary directly, not wrapped. This caused the backend to receive the entire `{ run_config: {...} }` object as `run_config`, which didn't have a `checks` key at the top level.

**What Worked:**

1. **Added `checks` to `runConfig` in App.tsx** (lines 200-202):

   ```typescript
   if (config.checks) {
     runConfig.checks = config.checks;
   }
   ```

2. **Added `checks` to `runConfig` in RunsPage.tsx** (lines 481-483):

   ```typescript
   if (config.checks) {
     runConfig.checks = config.checks;
   }
   ```

3. **Fixed request body structure in RunsPage.tsx** (lines 485-489):
   Changed from:

   ```typescript
   const requestBody: any = {};
   if (Object.keys(runConfig).length > 0) {
     requestBody.run_config = runConfig;
   }
   body: Object.keys(requestBody).length > 0
     ? JSON.stringify(requestBody)
     : undefined;
   ```

   To:

   ```typescript
   const requestBody =
     Object.keys(runConfig).length > 0 ? runConfig : undefined;
   body: requestBody ? JSON.stringify(requestBody) : undefined;
   ```

   This matches how `App.tsx` sends the request body, ensuring FastAPI receives `runConfig` directly as the `run_config` parameter.

4. **Backend conditional execution** - The backend already had logic to check `run_config.checks.duplicates`, but it was defaulting to `True` when the key was missing. Now that `checks` is always sent, the backend correctly respects `False` values.

**Files Modified:**

- `frontend/src/App.tsx` (lines 200-202) - Added `config.checks` to `runConfig`
- `frontend/src/pages/RunsPage.tsx` (lines 481-489) - Added `config.checks` to `runConfig` and fixed request body structure
- `backend/services/integrity_runner.py` (lines 621-650) - Conditional check execution logic (already existed, now works correctly)

**Impact:** Duplicate checks (and other checks like `links` and `required_fields`) now only run when explicitly selected in the frontend. The backend correctly respects the `checks` configuration sent from the frontend.

**Key Lessons:**

1. **Multiple code paths** - Always check for multiple entry points when debugging frontend issues. Different pages may have separate implementations of the same functionality.

2. **FastAPI Body parameter** - When using `Body(default=None)`, the request body should be the value directly, not wrapped in another object. FastAPI will extract it as the parameter name.

3. **Default values vs missing keys** - When checking for optional configuration, distinguish between "key missing" (should use default) and "key present with False value" (should respect False). The backend now explicitly checks for key existence before defaulting.

---

### Firestore Project Mismatch Fix (2025-01-27)

**Issue:** Manual scans weren't loading or appearing in the runs list. The frontend would wait for the run document to appear but timeout after 30 seconds, showing "Could not find run" error. Backend logs showed successful document creation, but the frontend's `onSnapshot` listener and polling mechanism never detected the document.

**What We Tried (That Didn't Work):**

1. **Polling fallback mechanism** - Added a `getDoc` polling mechanism in `frontend/src/App.tsx` as a fallback to `onSnapshot`, thinking it was a race condition or real-time listener reliability issue. This didn't work because the document truly didn't exist in the project the frontend was querying.

2. **Increased timeout** - Increased `maxWait` from 10s to 30s in `frontend/src/pages/RunsPage.tsx`, assuming the document creation was just slow. This didn't help because the document was being created in a completely different Firestore project.

3. **Initial run document creation** - Added immediate run document creation at the start of `IntegrityRunner.run()` to ensure the document exists before any processing begins. This worked correctly but didn't solve the visibility issue.

4. **Extensive logging instrumentation** - Added debug logs throughout the backend and frontend to trace document creation and detection. The logs revealed that backend was successfully writing documents, but frontend polling always returned `exists=false`.

**Root Cause:**

Backend and frontend were using **different Firestore projects**:
- **Backend**: "che-toolkit" (from Application Default Credentials via `gcloud auth application-default login`)
- **Frontend**: "data-integrity-monitor" (from `VITE_FIREBASE_PROJECT_ID` environment variable and `.firebaserc`)

The backend was successfully writing run documents to the "che-toolkit" project, but the frontend was querying the "data-integrity-monitor" project. Since these are separate Firestore instances, the documents were never visible to the frontend.

**What Worked:**

Updated `backend/clients/firestore.py` to explicitly use the "data-integrity-monitor" project (matching the frontend and `.firebaserc`):

1. **Added project ID resolution** (lines 46-51):
   ```python
   # Determine project ID - prefer env vars, fallback to data-integrity-monitor (matches .firebaserc)
   project_id = (
       os.getenv("GOOGLE_CLOUD_PROJECT")
       or os.getenv("GCP_PROJECT_ID")
       or "data-integrity-monitor"
   )
   ```

2. **Explicitly pass project when creating Firestore client** (lines 72, 93, 113):
   - When using service account credentials: `firestore.Client(credentials=credentials, project=cred_project_id)`
   - When using Application Default Credentials: `firestore.Client(project=project_id)`

   This ensures the backend always uses the same project as the frontend, regardless of what Application Default Credentials are configured.

**Files Modified:**

- `backend/clients/firestore.py` - Added explicit project ID resolution and passing to Firestore client constructor
- All debug instrumentation removed after verification

**Impact:** Both backend and frontend now use the same Firestore project ("data-integrity-monitor"), so run documents are immediately visible to the frontend. Manual scans now load correctly and appear in the runs list without timeouts.

**Key Lessons:**

1. **Project ID mismatch** - When debugging Firestore visibility issues, always verify that both backend and frontend are using the same Firestore project. Application Default Credentials can default to a different project than what's configured in environment variables or config files.

2. **Explicit is better than implicit** - Always explicitly pass the project ID when creating Firestore clients rather than relying on Application Default Credentials, which may point to an unexpected project.

3. **Logging reveals the truth** - Adding instrumentation to log project IDs on both sides quickly revealed the mismatch. The backend logs showed "che-toolkit" while frontend logs showed "data-integrity-monitor".

---

### Rule Selection Bug Fix (2025-12-26)

**Issue:** Selecting individual rules in scan configuration caused ALL rules in that category to execute instead of just the selected ones.

**Root Cause:** Frontend sent double-nested request body `{run_config: {entities: [...], rules: {...}}}` which, combined with FastAPI's `Body()` parameter named `run_config`, created `{run_config: {run_config: {...}}}`. This caused `run_config.get("rules")` to return `None`, skipping filtering entirely.

**Solution:** Changed `frontend/src/App.tsx` to send `runConfig` directly as request body instead of wrapping it in `{run_config: ...}`.

**Files Modified:**

- `frontend/src/App.tsx` (lines 209-224) - Removed double-nesting
- `backend/services/integrity_runner.py` (lines 1310, 1349, 1395) - Fixed indentation bugs
- `backend/services/integrity_runner.py` (lines 1312-1314, 1351-1354, 1397-1400) - Removed duplicate `else` blocks

**Impact:** Rule selection now works correctly. Only explicitly selected rules execute in scans.

**Detailed Documentation:** See `context-rules-fix.md` for complete debugging journey including all attempts and lessons learned.

---

## Archived Troubleshooting & Fixes

### CORS Policy and 500 Internal Server Error (2025-01-XX)

**Issue:**

- Browser console showed: `Access to fetch at 'http://localhost:8000/airtable/schema' from origin 'http://localhost:5173' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource`
- Backend returned `500 (Internal Server Error)` when accessing `/airtable/schema` endpoint
- Schema page failed to load and schema.json download failed

**What We Tried (That Didn't Work):**

1. **Initial CORS configuration changes** - Modified `backend/main.py` to parse `ALLOWED_ORIGINS` environment variable and set default localhost origins. This didn't fix the issue because the 500 error was preventing CORS headers from being added.
2. **Frontend token refresh** - Attempted to use `user.getIdToken(true)` to force fresh token retrieval, but this wasn't the root cause.
3. **Backend logging instrumentation** - Added extensive NDJSON logging to track request flow, but this revealed the actual error.

**Root Cause:**
The 500 error was caused by an `UnboundLocalError` in `backend/middleware/auth.py` at line 138. The function `verify_firebase_token` had a local `import time` statement inside an exception handler (line 202), which made Python treat `time` as a local variable throughout the entire function scope. When the code tried to use `time.time()` earlier in the function (line 138), Python raised `UnboundLocalError: cannot access local variable 'time' where it is not associated with a value` because it expected `time` to be assigned locally later in the function.

**What Worked:**

1. **Removed conflicting local import** - Removed the redundant `import time` statement from the exception handler in `verify_firebase_token()` since `time` was already imported at the module level (line 7 of `auth.py`).
2. **Added global exception handler** - Added a global exception handler in `backend/main.py` that ensures CORS headers are always present on error responses, preventing CORS errors even when exceptions occur:
   ```python
   @app.exception_handler(Exception)
   async def global_exception_handler(request: Request, exc: Exception):
       """Global exception handler that ensures CORS headers are always present."""
       # Creates JSONResponse with proper CORS headers even on errors
   ```
3. **Improved CORS configuration** - Enhanced CORS middleware setup to properly handle localhost origins and credentials:
   ```python
   allowed_origins = ["http://localhost:5173", "http://127.0.0.1:5173"]
   use_credentials = "*" not in allowed_origins
   ```

**Files Modified:**

- `backend/middleware/auth.py` - Removed redundant `import time` from exception handler
- `backend/main.py` - Added global exception handler for CORS headers, improved CORS configuration
- All debug instrumentation removed after verification

**Key Lesson:**
When Python sees an assignment or import to a variable name anywhere in a function, it treats that variable as local throughout the entire function scope. This can cause `UnboundLocalError` if you try to use the variable before the assignment. Always use module-level imports and avoid local imports that shadow module-level names.

These older fixes are documented here for historical reference but are superseded by more recent work. See deliverable log above for current state.
