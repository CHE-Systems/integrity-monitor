# Hanging Scheduled Runs - Implementation Summary

## Problem Solved

Fixed the issue where scheduled integrity runs would hang indefinitely when the application ran without localhost (computer closed), causing multiple runs to pile up in "running" state.

**Root Cause:** Missing socket-level timeouts in Airtable API requests caused connections to hang indefinitely when network conditions changed (e.g., computer closed → network transitions).

---

## Changes Implemented

### 1. Socket-Level Timeout (5 minutes) ✅

**File:** [backend/clients/airtable.py](backend/clients/airtable.py)

**Changes:**
- Added `REQUEST_TIMEOUT_SECONDS` constant (default: 300s = 5 minutes)
- Configured pyairtable `Api` with timeout parameter: `timeout=(300, 300)`
- This prevents indefinite hangs during record fetching (~10k records per entity)

**Lines modified:**
- Line 23-25: Added timeout constant
- Line 68-72: Configured Api with timeout

```python
# Socket-level timeout for large record fetches
REQUEST_TIMEOUT_SECONDS = int(os.getenv("AIRTABLE_REQUEST_TIMEOUT_SECONDS", "300"))

# In _get_api():
timeout = (REQUEST_TIMEOUT_SECONDS, REQUEST_TIMEOUT_SECONDS)
self._api = Api(token, timeout=timeout)
```

---

### 2. Run-Level Timeout (30 minutes) ✅

**File:** [backend/services/integrity_runner.py](backend/services/integrity_runner.py)

**Changes:**
- Added `MAX_RUN_DURATION_SECONDS` constant (default: 1800s = 30 minutes)
- Implemented timeout mechanism using `threading.Timer`
- Added `TimeoutError` exception handler to mark runs as "timeout" status
- Timer automatically cancels in `finally` block

**Lines modified:**
- Line 6-7: Added `os` and `threading` imports
- Line 34-36: Added timeout constant
- Line 153-177: Timeout setup and handler
- Line 179-184: Enhanced `check_cancelled()` to check timeout
- Line 670-693: `TimeoutError` exception handler
- Line 744-746: Timer cancellation in finally block

**How it works:**
1. Timer starts when run begins
2. If run exceeds 30 minutes, `handle_timeout()` is called
3. `timeout_triggered` event is set
4. Next `check_cancelled()` call raises `TimeoutError`
5. Run is marked as "timeout" status in Firestore

---

### 3. Timeout Status Support ✅

**Frontend Files:**

**[frontend/src/hooks/useRunStatus.ts](frontend/src/hooks/useRunStatus.ts)**
- Line 8: Added "timeout" to status union type
```typescript
status: "running" | "success" | "error" | "warning" | "timeout";
```

**[frontend/src/hooks/useFirestoreRuns.ts](frontend/src/hooks/useFirestoreRuns.ts)**
- Line 55: Added timeout status handling in display mapping
```javascript
if (statusLower === "timeout") return "Timeout";
```

---

### 4. Hung Run Cleanup Cloud Function ✅

**File:** [functions/index.js](functions/index.js)

**New Function:** `cleanupHungRuns`
- **Schedule:** Every 10 minutes
- **Purpose:** Detect and clean up runs stuck in "running" state
- **Threshold:** 30 minutes (runs older than this are marked as timeout)
- **Lines:** 591-679

**How it works:**
1. Queries `integrity_runs` collection for:
   - `status = "running"`
   - `started_at < (now - 30 minutes)`
2. Updates these runs to:
   - `status = "timeout"`
   - `ended_at = now`
   - `error_message = "Run exceeded maximum duration..."`
3. Logs all cleanup actions

---

### 5. Environment Variable Documentation ✅

**File:** [backend/.env.example](backend/.env.example)

**Added:**
```bash
# Airtable Timeout Configuration
# Socket-level timeout for Airtable API requests (seconds)
# Default: 300 seconds = 5 minutes (handles ~10k records per entity)
AIRTABLE_REQUEST_TIMEOUT_SECONDS=300

# Maximum duration for an integrity run (seconds)
# Runs exceeding this duration will be terminated and marked as "timeout"
# Default: 1800 seconds = 30 minutes
MAX_RUN_DURATION_SECONDS=1800
```

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AIRTABLE_REQUEST_TIMEOUT_SECONDS` | 300 (5 min) | Socket timeout for Airtable API requests |
| `MAX_RUN_DURATION_SECONDS` | 1800 (30 min) | Maximum run duration before timeout |

### Cloud Function Settings

| Function | Schedule | Threshold | Action |
|----------|----------|-----------|--------|
| `cleanupHungRuns` | Every 10 minutes | 30 minutes | Mark as "timeout" |

---

## Testing Recommendations

### 1. Test Socket Timeout
```bash
# Set a very short timeout to test
export AIRTABLE_REQUEST_TIMEOUT_SECONDS=10

# Run a scan and observe timeout behavior
python -m backend.main
```

**Expected:** Scan fails with timeout error after 10 seconds during record fetch.

### 2. Test Run-Level Timeout
```bash
# Set a very short run timeout
export MAX_RUN_DURATION_SECONDS=60

# Start a full scan
# Expected: Run is terminated after 60 seconds with "timeout" status
```

### 3. Test Hung Run Cleanup

**Scenario:** Create a run that hangs (e.g., stop backend mid-scan)

1. Start a scan and kill the process
2. Run is left in "running" state
3. Wait for cleanup function (runs every 10 min)
4. Or manually trigger: `firebase functions:shell` → `cleanupHungRuns()`

**Expected:** Run is marked as "timeout" with appropriate error message.

### 4. Test with Computer Closed

**Real-world test:**
1. Create a schedule (e.g., hourly)
2. Ensure schedule is enabled
3. Close laptop/computer
4. Wait 1-2 hours
5. Open laptop and check Firestore

**Expected:**
- All runs have completed (not stuck in "running")
- Runs either succeeded or timed out (no indefinite hangs)
- No pile-up of stuck runs

---

## Monitoring

### Check for Hung Runs

**Firestore Query:**
```javascript
db.collection('integrity_runs')
  .where('status', '==', 'running')
  .where('started_at', '<', twentyMinutesAgo)
  .get()
```

**Expected Result:** No documents (cleanup function removes them)

### Check Timeout Frequency

**Firestore Query:**
```javascript
db.collection('integrity_runs')
  .where('status', '==', 'timeout')
  .orderBy('started_at', 'desc')
  .limit(10)
  .get()
```

**Action:** If many timeouts occur, increase timeout values:
- Increase `AIRTABLE_REQUEST_TIMEOUT_SECONDS` if fetches timeout
- Increase `MAX_RUN_DURATION_SECONDS` if full runs timeout

---

## Rollback Plan

If issues occur after deployment:

1. **Disable cleanup function:**
   ```bash
   # Comment out or remove exports.cleanupHungRuns in functions/index.js
   # Redeploy functions
   ```

2. **Increase timeout values:**
   ```bash
   # In backend/.env or Cloud Run environment
   AIRTABLE_REQUEST_TIMEOUT_SECONDS=600  # 10 minutes
   MAX_RUN_DURATION_SECONDS=3600         # 60 minutes
   ```

3. **Monitor logs:**
   ```bash
   firebase functions:log --only cleanupHungRuns
   ```

---

## Deployment Steps

### 1. Backend (Cloud Run)

```bash
cd backend

# Update .env with new variables (if not using defaults)
echo "AIRTABLE_REQUEST_TIMEOUT_SECONDS=300" >> .env
echo "MAX_RUN_DURATION_SECONDS=1800" >> .env

# Deploy to Cloud Run
gcloud run deploy integrity-runner \
  --source . \
  --region us-central1 \
  --set-env-vars="AIRTABLE_REQUEST_TIMEOUT_SECONDS=300,MAX_RUN_DURATION_SECONDS=1800"
```

### 2. Cloud Functions

```bash
cd functions

# Deploy the new cleanup function
firebase deploy --only functions:cleanupHungRuns

# Or deploy all functions
firebase deploy --only functions
```

### 3. Frontend

```bash
cd frontend

# Build and deploy
npm run build
firebase deploy --only hosting
```

---

## Success Criteria

✅ **Zero hung runs** after 1 week with computer closed
✅ **All scheduled runs complete** with status != "running"
✅ **No false positive timeouts** on healthy runs
✅ **Run durations** remain consistent (3-5 minutes for full scans)

---

## Files Modified

### Backend
- [backend/clients/airtable.py](backend/clients/airtable.py) - Socket timeout
- [backend/services/integrity_runner.py](backend/services/integrity_runner.py) - Run timeout
- [backend/.env.example](backend/.env.example) - Documentation

### Frontend
- [frontend/src/hooks/useRunStatus.ts](frontend/src/hooks/useRunStatus.ts) - Timeout status type
- [frontend/src/hooks/useFirestoreRuns.ts](frontend/src/hooks/useFirestoreRuns.ts) - Timeout display

### Cloud Functions
- [functions/index.js](functions/index.js) - Cleanup function

### Documentation
- [DIAGNOSIS-AND-FIX-PLAN.md](DIAGNOSIS-AND-FIX-PLAN.md) - Detailed analysis
- [IMPLEMENTATION-SUMMARY.md](IMPLEMENTATION-SUMMARY.md) - This file

---

## Next Steps

1. **Deploy changes** to staging/production
2. **Monitor logs** for the first 24 hours:
   - Check for timeout errors
   - Verify cleanup function runs successfully
3. **Test with computer closed** for 1-2 days
4. **Adjust timeout values** if needed based on real-world performance
5. **Document any issues** encountered

---

## Support

If issues arise:

1. **Check logs:**
   - Cloud Run: `gcloud run services logs read integrity-runner`
   - Functions: `firebase functions:log`

2. **Review Firestore:**
   - Check `integrity_runs` for stuck runs
   - Check error_message field for timeout details

3. **Verify environment variables:**
   - Cloud Run: `gcloud run services describe integrity-runner`
   - Functions: Check Firebase console

---

**Implementation Date:** 2025-12-23
**Status:** ✅ Complete - Ready for Deployment
