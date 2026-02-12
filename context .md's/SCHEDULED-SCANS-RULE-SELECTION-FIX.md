# Scheduled Scans Rule Selection Fix (Rules Not Applied) — Postmortem

Date: 2026-01-09  
Status: Resolved  

## Final Fix (What actually fixed it)

**Root cause:** scheduled scans were hitting `POST /integrity/run?trigger=schedule...` with **an empty request body** (`content-length: 0`), so the backend received `run_config=None` and therefore **could not apply selected rules**.

**Fix implemented:**

1. **Firebase scheduled function now always sends a JSON body** and forces `Content-Length`:
   - `functions/index.js`
   - Always compute `const bodyString = JSON.stringify(requestBody)` and pass it as `body`.
   - Add header `Content-Length: Buffer.byteLength(bodyString, 'utf8')`.

2. **Backend now parses the body directly** (doesn’t depend on FastAPI’s `Body()` parsing for this endpoint):
   - `backend/main.py`
   - `await request.body()` then `json.loads(...)` to obtain `run_config`.

**Result:** scheduled scans send a non-empty `run_config` payload; the backend receives it; `IntegrityRunner` filters rules by the selected `run_config.rules` exactly like manual scans.

---

## Symptoms

- **Manual one-time scans worked**: selected entities + selected rules were applied correctly.
- **Scheduled scans did not**: even with the exact same entity + rule selection saved in the schedule, scheduled runs behaved as though **no rule selection existed** (looked like “all rules” or “defaults” depending on check configuration).
- Cloud Run logs for the scheduled call showed:
  - `Request method: POST`
  - `content-type: application/json`
  - **`content-length: 0`**
  - backend reading raw body bytes resulted in **empty body**
  - backend printed that `run_config` was `None`

In short: the scheduled trigger request looked like JSON, but **carried no bytes**.

---

## Expected Behavior (Contract)

Both manual and scheduled scans should call the same backend endpoint (`POST /integrity/run`) with:

- `trigger` (manual vs schedule)
- `entities` (optional; can be query params or in the JSON body)
- `run_config` body containing:
  - `entities`: list of entities to run
  - `rules`: selected rules by category (duplicates / relationships / required_fields / value_checks / attendance_rules)
  - `checks`: which check categories to execute
  - optional `notify_slack`

Backend behavior:

- If `run_config.rules` is present: filter schema/rules to selected items only.
- If `run_config` is absent: default behavior (no rule filtering).

---

## What we proved with runtime evidence (the “aha” moment)

### Key observation

Cloud Run logs for scheduled runs consistently showed:

- `content-length: 0`
- raw body length `0`
- `run_config=None`

This removed almost all ambiguity:

- the frontend schedule config in Firestore could be correct
- the backend rule filtering could be correct
- **but none of it matters if the scheduled trigger doesn’t send a request body**

So the discrepancy was not “scheduled scans ignore rules” — it was **“scheduled scans are not actually sending `run_config` to the backend.”**

---

## What we tried repeatedly that was NOT the fix (and why)

This issue took multiple iterations because early hypotheses focused on backend parsing and rule filtering rather than upstream request construction.

### 1) Investigated rule filtering discrepancies (backend)

**Hypothesis:** scheduled runs may be using a different code path or skipping `_filter_rules_by_selection`.

- Added logging inside `IntegrityRunner` to inspect:
  - `run_config` presence
  - rule categories
  - filtering decisions

**Outcome:** not the fix. The runner logic was fine — it simply had `run_config=None` in scheduled runs.

### 2) Assumed FastAPI `Body(default=None)` was failing

**Hypothesis:** FastAPI was not binding the JSON body into the `run_config` parameter for scheduled requests.

Actions attempted:

- Made endpoint `async def`
- Added a fallback: if `run_config is None`, then `await request.body()` and `json.loads`
- Then removed `Body()` completely and always read the raw body

**Outcome:** not the fix by itself. This did improve robustness, but Cloud Run logs still showed `content-length: 0` (i.e., there was **no body to parse**).

### 3) Deployment wasn’t picking up changes (Cloud Run caching confusion)

**Hypothesis:** code changes weren’t deployed; therefore new logs didn’t appear.

Actions attempted:

- Added obvious “API ENTRY” prints at the top of the endpoint.
- Confirmed whether those logs appear in Cloud Run.
- Added a cache-busting comment to `backend/Dockerfile` to force rebuild during `gcloud run deploy --source backend`.

**Outcome:** this was not the root cause, but it was an important stepping stone:

- Once the updated code was definitely deployed, Cloud Run showed the decisive evidence: **the request body was empty**.

### 4) Verified Firestore schedule records / UI config plumbing (frontend)

**Hypothesis:** schedule creation might be saving an incomplete `run_config` to Firestore, or reading it back incorrectly.

Actions attempted:

- Added instrumentation in scheduling UI save flow.
- Added instrumentation in schedule execution read hooks.

**Outcome:** not the fix. The schedule config in Firestore looked correct; the problem was between the function and Cloud Run.

### 5) Added “log selected rules at scan start” (runner realtime logs)

You requested a realtime log at scan initiation showing selected rules prior to record fetching.

We added that logging so the UI could show what the scan *thinks* it will run.

**Outcome:** helpful for visibility, but not the fix — the scheduled run never had rule selections because it never received `run_config`.

---

## The actual root cause

The Firebase scheduled function (`runScheduledScans`) was making the backend fetch call such that **no request body was transmitted** (or it was being dropped), resulting in:

- `content-length: 0` at Cloud Run
- empty raw body
- `run_config=None` at API entry

Even though headers indicated JSON, the payload was empty.

---

## The final changes that fixed it

### A) Firebase Functions: always send JSON body + explicit `Content-Length`

In `functions/index.js`:

- Always compute `bodyString = JSON.stringify(requestBody)`
- Set headers:
  - `Content-Type: application/json`
  - `Content-Length: Buffer.byteLength(bodyString, 'utf8')`
- Send `body: bodyString`

This ensured Cloud Run reliably received non-empty bytes and the backend could parse them.

### B) Backend: parse raw body explicitly

In `backend/main.py`:

- Parse request body via `await request.body()`
- `json.loads(...)` into `run_config`
- Proceed with the same `IntegrityRunner` logic

This removed reliance on parameter binding edge cases and made backend behavior consistent for manual + scheduled triggers.

---

## Verification (how we knew it was fixed)

Before fix:

- Cloud Run logs showed `content-length: 0`
- API read `len(body_bytes)=0`
- `run_config=None`
- rules were not filtered

After fix:

- Cloud Run logs showed a non-zero body length (non-empty bytes)
- backend parsed `run_config`
- scheduled scans applied selected rules identically to manual scans

---

## Follow-ups / hardening

### Deployment caching

While not the root cause, “are my changes actually deployed?” became a recurring source of confusion during debugging. As a result:

- We updated deployment tooling so backend deployments can **force a clean rebuild**.
- `deploy/deploy.sh` now builds with Cloud Build using `docker build --no-cache` and deploys via `--image`, which eliminates the “cached old code” failure mode during production debugging.

---

## Lessons learned

- **Always validate the payload at the receiver first.** “Rules not applied” was downstream; the real cause was that `run_config` never arrived.
- **Cloud Run `content-length: 0` is decisive.** Once observed, stop investigating parsing and focus on the sender.
- **Make deployment determinism easy.** When debugging production issues, a reliable “no-cache build” path saves hours.

