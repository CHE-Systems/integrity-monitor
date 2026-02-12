# Hanging Scheduled Runs - Diagnosis & Fix Plan

## Problem Summary

**Symptom:** When schedules run automatically without localhost running (computer closed), runs start but hang during the "Fetching records" phase and never complete. Multiple runs pile up in "running" state.

**Works fine:** When localhost is running, scheduled scans complete successfully.

**Evidence from logs:** Run gets stuck after "Fetching classes records..." and never proceeds to the checks phase.

---

## Root Cause Analysis

### PRIMARY CAUSE: Missing Socket-Level Timeout in Airtable Requests

**Location:** [backend/clients/airtable.py:148](backend/clients/airtable.py#L148)

**The Problem:**
```python
all_records = table.all()  # Line 148 - NO TIMEOUT!
```

The `table.all()` call from pyairtable uses Python's `requests` library under the hood, but **no timeout parameter is configured**. This means:

- When network conditions are poor (computer closed → network changes), the socket can hang **indefinitely** waiting for data
- The `API_TIMEOUT_SECONDS = 30` constant (line 22) only applies to the **retry mechanism**, NOT to individual socket operations
- The retry decorator (lines 118-123) won't help if the initial connection hangs—it only retries on exceptions

**Why it works on localhost:**
- Stable network connection (WiFi/Ethernet)
- Low latency to Airtable API
- Process stays alive with consistent network state

**Why it fails when computer is closed:**
- Network transitions (WiFi → cellular, VPN disconnects, etc.)
- Cloud Run or similar platforms may have different network routing
- Socket connections can enter a "hung" state waiting for TCP packets that never arrive

---

### SECONDARY CAUSE: No Run-Level Timeout

**Location:** [backend/services/integrity_runner.py:744-800](backend/services/integrity_runner.py#L744-L800)

**The Problem:**
- The `_fetch_records()` method has **no timeout wrapper**
- If one entity fetch hangs, the entire run hangs forever
- Background thread runs indefinitely (daemon thread in [backend/main.py:403](backend/main.py#L403))
- No mechanism to detect or kill runs that exceed reasonable duration

**Expected behavior:**
- Full scans with all entities typically complete in 3-5 minutes
- Any run taking >15 minutes is likely hung
- Should timeout and mark run as "error" or "timeout"

---

### TERTIARY CAUSE: No Hung Run Detection/Cleanup

**Location:** [functions/index.js:468-589](functions/index.js#L468-L589)

**The Problem:**
- `updateScheduleExecutionStatus` runs every 2 minutes
- It only checks if runs have completed, not if they're hung
- No cleanup mechanism for runs stuck in "running" state for extended periods
- Hung runs accumulate and consume resources

---

## Diagnostic Steps to Confirm

Before implementing fixes, let's confirm the diagnosis:

### 1. Check Current Hung Runs

```bash
# Query Firestore to see stuck runs
# Look for runs with status="running" that are >15 minutes old
```

**Expected outcome:** Find multiple runs in "running" state from when computer was closed.

### 2. Review Pyairtable Request Configuration

**Check:** Does pyairtable's underlying requests library have timeout configured?

**File to inspect:** Virtual environment's pyairtable source code

**Expected outcome:** No timeout configured by default.

### 3. Test Network Timeout Behavior

**Reproduce the hang:**
1. Start a scheduled run
2. Simulate network instability (disconnect WiFi mid-fetch)
3. Observe if run hangs or times out

**Expected outcome:** Run hangs indefinitely.

---

## Solution Design

### Solution 1: Add Socket-Level Timeout (CRITICAL - Must Do)

**Goal:** Ensure all HTTP requests to Airtable API have hard timeouts.

**Implementation:**

**File:** [backend/clients/airtable.py](backend/clients/airtable.py)

**Approach:**
1. Add timeout configuration constant (e.g., `REQUEST_TIMEOUT_SECONDS = 60`)
2. Configure timeout when creating the pyairtable API instance
3. Pyairtable passes timeout to underlying requests library

**Code change (conceptual):**
```python
# Add constant - 5 minutes for large record fetches (10k+ records per entity)
REQUEST_TIMEOUT_SECONDS = int(os.getenv("AIRTABLE_REQUEST_TIMEOUT_SECONDS", "300"))

# In _get_api() method or _fetch_with_retry():
# Option A: Configure session timeout (if pyairtable supports it)
api = Api(api_key, timeout=REQUEST_TIMEOUT_SECONDS)

# Option B: If pyairtable doesn't support timeout, patch table.all()
# Use requests.Session with timeout configuration
```

**Research needed:**
- Does pyairtable Api constructor accept a timeout parameter?
- Does it accept a custom requests.Session?
- May need to monkeypatch or wrap the call

**Priority:** CRITICAL - This is the root cause

**Complexity:** Medium (depends on pyairtable API)

**Risk:** Low (timeout is safe, will raise exception that's already caught)

---

### Solution 2: Add Run-Level Timeout (HIGH PRIORITY)

**Goal:** Kill runs that exceed maximum expected duration.

**Implementation:**

**File:** [backend/services/integrity_runner.py](backend/services/integrity_runner.py)

**Approach:**
1. Add configurable timeout for entire run (e.g., `MAX_RUN_DURATION_MINUTES = 30`)
2. Wrap the main run logic in a timeout handler
3. If timeout exceeded, cancel run and mark as "timeout" status (new status type)

**Options:**

**Option A: Thread-based timeout using threading.Timer**
```python
def run_integrity_check(self, ...):
    timeout_seconds = int(os.getenv("MAX_RUN_DURATION_SECONDS", "1800"))  # 30 min

    def timeout_handler():
        logger.error("Run exceeded timeout", extra={"run_id": run_id})
        # Set flag or raise exception

    timer = threading.Timer(timeout_seconds, timeout_handler)
    timer.start()

    try:
        # ... existing run logic ...
    finally:
        timer.cancel()
```

**Option B: Use signal.alarm (Unix only, won't work on Windows)**
```python
import signal

def run_integrity_check(self, ...):
    def timeout_handler(signum, frame):
        raise TimeoutError("Run exceeded maximum duration")

    signal.signal(signal.SIGALRM, timeout_handler)
    signal.alarm(1200)  # 20 minutes

    try:
        # ... existing run logic ...
    finally:
        signal.alarm(0)  # Cancel alarm
```

**Option C: Use concurrent.futures with timeout**
```python
from concurrent.futures import ThreadPoolExecutor, TimeoutError

def run_integrity_check(self, ...):
    timeout_seconds = int(os.getenv("MAX_RUN_DURATION_SECONDS", "1800"))  # 30 min

    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(self._run_check_logic, ...)
        try:
            result = future.wait(timeout=timeout_seconds)
        except TimeoutError:
            logger.error("Run timed out")
            # Mark run as "timeout" status
            raise
```

**Recommended:** Option C (most portable, clean error handling)

**Priority:** HIGH

**Complexity:** Medium

**Risk:** Medium (need to handle cleanup properly)

---

### Solution 3: Add Hung Run Detection & Cleanup (MEDIUM PRIORITY)

**Goal:** Detect and clean up runs that are stuck in "running" state.

**Implementation:**

**Option A: Add cleanup Cloud Function**

**File:** [functions/index.js](functions/index.js)

**New function:** `cleanupHungRuns`
- Runs every 10 minutes
- Queries `integrity_runs` collection for runs with:
  - `status = "running"`
  - `created_at < (now - 30 minutes)`
- Updates these runs to status="timeout"
- Logs cleanup action

**Code (conceptual):**
```javascript
exports.cleanupHungRuns = functions.pubsub
  .schedule('every 10 minutes')
  .timeoutSeconds(120)
  .onRun(async (context) => {
    const db = admin.firestore();
    const cutoff = admin.firestore.Timestamp.fromDate(
      new Date(Date.now() - 30 * 60 * 1000)  // 30 minutes ago
    );

    const hungRuns = await db.collection('integrity_runs')
      .where('status', '==', 'running')
      .where('created_at', '<', cutoff)
      .get();

    for (const doc of hungRuns.docs) {
      await doc.ref.update({
        status: 'timeout',
        error_message: 'Run exceeded maximum duration and was automatically terminated',
        finished_at: admin.firestore.FieldValue.serverTimestamp()
      });

      console.log(`Cleaned up hung run: ${doc.id}`);
    }
  });
```

**Option B: Enhance existing updateScheduleExecutionStatus**

Add hung run detection to the existing status update function.

**Priority:** MEDIUM (nice to have, but Solutions 1 & 2 should prevent hangs)

**Complexity:** Low

**Risk:** Very Low (read-only detection, safe updates)

---

### Solution 4: Improve Error Handling & Logging (NICE TO HAVE)

**Goal:** Better visibility into what's happening when runs hang.

**Improvements:**
1. Add timeout logging in Airtable client
2. Log network conditions (if possible)
3. Add heartbeat logging during long operations
4. Enhanced error messages for timeout scenarios

**Priority:** LOW

**Complexity:** Low

**Risk:** None

---

## Implementation Plan

### Phase 1: Quick Fix (Solve the immediate problem)

**Tasks:**
1. ✅ **Add socket timeout to Airtable requests**
   - Research pyairtable timeout configuration
   - Add `REQUEST_TIMEOUT_SECONDS` configuration
   - Test with network interruption simulation
   - **Files:** [backend/clients/airtable.py](backend/clients/airtable.py)

2. ✅ **Add run-level timeout**
   - Implement using concurrent.futures
   - Add `MAX_RUN_DURATION_SECONDS` configuration
   - Test timeout behavior
   - **Files:** [backend/services/integrity_runner.py](backend/services/integrity_runner.py)

3. ✅ **Clean up existing hung runs manually**
   - Query Firestore for hung runs
   - Update status to "timeout"
   - Document run IDs for analysis

**Estimated time:** 2-4 hours
**Testing:** Deploy to staging, trigger scheduled runs with computer closed

---

### Phase 2: Robust Protection (Prevent future issues)

**Tasks:**
1. ✅ **Add hung run cleanup Cloud Function**
   - Implement `cleanupHungRuns` function
   - Schedule every 10 minutes
   - Deploy and monitor
   - **Files:** [functions/index.js](functions/index.js)

2. ✅ **Add monitoring/alerting**
   - Alert if >5 runs in "running" state
   - Alert if any run exceeds 15 minutes
   - Dashboard showing run durations

3. ✅ **Enhanced logging**
   - Add timestamps to fetch operations
   - Log network timeout exceptions clearly
   - Add run duration metrics

**Estimated time:** 3-5 hours

---

### Phase 3: Testing & Validation

**Test cases:**
1. **Normal execution:** Scheduled run completes successfully
2. **Network interruption:** Run times out gracefully, status updated
3. **API slowness:** Partial timeout (some entities fetch, others timeout)
4. **Cleanup function:** Hung runs from Phase 1 testing are cleaned up
5. **Multiple schedules:** Multiple schedules running concurrently don't interfere

**Monitoring period:** 1 week with computer closed periodically

---

## Configuration Changes

### New Environment Variables

**Backend (.env):**
```bash
# Socket-level timeout for Airtable API requests (seconds)
# Default: 300 seconds = 5 minutes (for large record fetches ~10k records)
AIRTABLE_REQUEST_TIMEOUT_SECONDS=300

# Maximum duration for entire integrity run (seconds)
# Default: 1800 seconds = 30 minutes
MAX_RUN_DURATION_SECONDS=1800

# Hung run threshold for cleanup (minutes)
# Runs in "running" state longer than this are marked as timeout
HUNG_RUN_THRESHOLD_MINUTES=30
```

**Cloud Functions:**
```javascript
// In functions/index.js
const HUNG_RUN_THRESHOLD_MINUTES = 30;
const CLEANUP_SCHEDULE = 'every 10 minutes';
```

---

## Risk Assessment

### Risks of Making These Changes

**Low Risk:**
- Adding timeouts is safe—exceptions are already caught
- Cleanup function is non-destructive (only updates status)
- Existing retry logic still works

**Medium Risk:**
- If timeout is too aggressive, healthy runs might be killed
- Need to tune timeout values based on actual data volumes

**Mitigation:**
- Start with appropriate timeouts (5min socket for ~10k records, 30min run)
- Monitor logs for timeout frequency
- Adjust based on real-world data

---

## Monitoring & Success Criteria

### Success Metrics

1. **Zero hung runs** after 1 week with computer closed
2. **All scheduled runs complete** with status != "running"
3. **No false positive timeouts** on healthy runs
4. **Run durations** remain consistent (3-5 minutes for full scans)

### Monitoring Queries

**Find hung runs:**
```javascript
db.collection('integrity_runs')
  .where('status', '==', 'running')
  .where('created_at', '<', twentyMinutesAgo)
  .get()
```

**Run duration analysis:**
```javascript
db.collection('integrity_runs')
  .where('finished_at', '>', last24Hours)
  .get()
  // Calculate: finished_at - created_at for each run
```

---

## Questions for User

Before implementing, please confirm:

**✅ CONFIRMED BY USER:**
- Socket timeout: 5 minutes (300 seconds) - handles ~10k records per entity
- Run-level timeout: 30 minutes (1800 seconds)
- Timeout status: New "timeout" status for runs exceeding 30 minutes
- Data volume: ~10,000 records per entity

**REMAINING QUESTIONS:**
1. **Alerting:** Do you want email/Slack notifications when runs timeout?

2. **Priority:** Should we implement all phases or just Phase 1 quick fix?

3. **Testing:** Can you trigger a test schedule while computer is closed to validate the fix?

---

## Next Steps

Once you approve this plan, I'll proceed with:

1. **Immediate:** Research pyairtable timeout configuration
2. **Phase 1 Implementation:** Add socket and run-level timeouts
3. **Testing:** Validate fix with computer closed scenario
4. **Phase 2 Implementation:** Add cleanup function and monitoring
5. **Documentation:** Update deployment docs with new env vars

---

## Files to be Modified

### Phase 1 (Critical Fixes)
- [backend/clients/airtable.py](backend/clients/airtable.py) - Add socket timeout
- [backend/services/integrity_runner.py](backend/services/integrity_runner.py) - Add run timeout
- [backend/.env.example](backend/.env.example) - Document new env vars

### Phase 2 (Robust Protection)
- [functions/index.js](functions/index.js) - Add cleanup function
- [functions/package.json](functions/package.json) - May need dependencies

### Phase 3 (Documentation)
- [README.md](README.md) - Document timeout configurations
- Deployment guide - Update with new env vars
