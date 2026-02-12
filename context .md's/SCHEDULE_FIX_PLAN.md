# Schedule Fix Plan

## Issues Identified

### 1. Frequency Calculation Bug (Hourly Intervals)

**Problem**: Schedules with hourly frequency and interval_minutes (e.g., 180 minutes = 3 hours) are not calculating next run times correctly.

**Root Cause**:

- In `computeNextRunAt()` function (functions/index.js:359-465), when `previousNextRunAt` is provided, it correctly increments by `intervalMinutes`
- However, the initial calculation (lines 380-405) has a bug when calculating intervals within an hour
- The calculation uses `totalCurrentSeconds / (intervalMinutes * 60)` which is wrong - it should divide by `intervalMinutes * 60` but the logic for handling intervals >= 60 minutes is flawed
- When `nextIntervalMinutes >= 60`, it tries to add hours, but this doesn't work correctly for intervals like 180 minutes

**Evidence**:

- Schedule set to run every 2 hours (120 minutes) shows "Every 180 minutes"
- First run: Dec 20, 1:00 AM
- Second run: Dec 20, 2:00 PM (13 hours later, not 2 hours)
- Then runs every minute instead of every 180 minutes

### 2. Runs Getting Stuck in "Running" Status

**Problem**: All schedule executions show "Running" status and never complete.

**Root Cause**:

- Execution status is set to "started" when run is triggered (functions/index.js:217, 303)
- There is NO mechanism to update the execution status when the integrity run completes
- The backend updates the integrity run status in Firestore, but the `schedule_executions` document is never updated
- The frontend shows "Running" because it checks the integrity run status, but the execution document itself remains "started"

**Evidence**: All 6 executions shown in the UI have "Running" status

### 3. Rapid Re-triggering (Every Minute)

**Problem**: After the first incorrect run, schedules start triggering every minute instead of at the correct interval.

**Root Cause**:

- When a run gets stuck, `next_run_at` is set to a time in the past (or very near future)
- The scheduler runs every minute and checks `next_run_at <= now`
- If the previous execution is still "started", there's no check to prevent re-triggering
- This causes the scheduler to trigger a new run every minute

**Evidence**: Executions at 2:00 PM, 2:01 PM, 2:02 PM, 2:03 PM, 2:04 PM

## Fix Plan

### Phase 1: Fix Frequency Calculation for Hourly Intervals

**File**: `functions/index.js` - `computeNextRunAt()` function

**Changes**:

1. **Fix interval calculation for intervals >= 60 minutes**:

   - When `intervalMinutes >= 60`, don't try to calculate within an hour
   - Simply add `intervalMinutes` to the current time (or previous next_run_at)
   - Remove the complex logic that tries to fit intervals into hours

2. **Simplify the logic**:

   ```javascript
   if (
     frequency === "hourly" &&
     intervalMinutes != null &&
     intervalMinutes > 0
   ) {
     if (previousNextRunAt) {
       // Always increment from previous time for subsequent runs
       nextRun = tz.plus({ minutes: intervalMinutes });
     } else {
       // For initial calculation, round up to next interval boundary
       const currentMinutes = tz.minute;
       const currentSeconds = tz.second;
       const totalCurrentMinutes = currentMinutes + currentSeconds / 60;

       // Calculate minutes until next interval
       const minutesUntilNext =
         intervalMinutes - (totalCurrentMinutes % intervalMinutes);

       // Add the minutes until next interval
       nextRun = tz
         .plus({ minutes: minutesUntilNext })
         .set({ second: 0, millisecond: 0 });
     }
   }
   ```

3. **Add validation**:
   - Ensure `intervalMinutes >= 1` (minimum 1 minute)
   - Log warning if interval is very large (> 1440 minutes = 24 hours) suggesting daily frequency instead

### Phase 2: Add Execution Status Update Mechanism

**Option A: Cloud Function Listener (Recommended)**

- Create a new Cloud Function that listens to changes in `integrity_runs` collection
- When a run status changes from "running" to any final status (success, error, warning, etc.), find the corresponding `schedule_executions` document and update its status
- Match by `run_id` field in schedule_executions

**Option B: Backend Callback**

- Add a callback mechanism in the backend that updates the execution status when run completes
- Requires backend to have access to execution_id, which would need to be passed or stored

**Option C: Scheduled Cleanup Job**

- Create a scheduled function that runs every 5 minutes
- Query for executions with status "started" that have a `run_id`
- Check the corresponding integrity run status
- Update execution status accordingly

**Recommended**: Option A (Cloud Function Listener) - most real-time and reliable

**Implementation**:

```javascript
exports.updateScheduleExecutionStatus = functions.firestore
  .document("integrity_runs/{runId}")
  .onUpdate(async (change, context) => {
    const newData = change.after.data();
    const oldData = change.before.data();

    // Only process if status changed from running to a final status
    if (oldData.status === "running" && newData.status !== "running") {
      const runId = context.params.runId;

      // Find execution with this run_id
      const executionsRef = db.collection("schedule_executions");
      const query = executionsRef.where("run_id", "==", runId).limit(1);
      const snapshot = await query.get();

      if (!snapshot.empty) {
        const executionDoc = snapshot.docs[0];
        await executionDoc.ref.update({
          status: newData.status === "success" ? "completed" : "error",
          completed_at: newData.ended_at || Timestamp.now(),
          error:
            newData.status === "error"
              ? {
                  message: newData.error_message || "Run failed",
                  code: "RUN_ERROR",
                }
              : null,
        });

        logger.info(
          `Updated execution ${executionDoc.id} status to ${newData.status}`
        );
      }
    }
  });
```

### Phase 3: Prevent Rapid Re-triggering

**File**: `functions/index.js` - `runScheduledScans` function

**Changes**:

1. **Add check for in-progress executions**:

   - Before triggering a new run, check if there's an execution with status "started" for this schedule
   - If found and it's less than 15 minutes old, skip triggering (run might still be in progress)
   - If found and it's more than 15 minutes old, mark it as "timeout" and allow new run

2. **Add timeout handling**:

   ```javascript
   // Before claiming schedule, check for stale executions
   const recentExecutionsRef = db.collection("schedule_executions");
   const staleExecutionsQuery = recentExecutionsRef
     .where("schedule_id", "==", scheduleId)
     .where("status", "==", "started")
     .orderBy("started_at", "desc")
     .limit(1);

   const staleSnapshot = await staleExecutionsQuery.get();
   if (!staleSnapshot.empty) {
     const staleExecution = staleSnapshot.docs[0].data();
     const startedAt = staleExecution.started_at;
     const ageMinutes = (now.toMillis() - startedAt.toMillis()) / (1000 * 60);

     if (ageMinutes < 15) {
       // Execution is still recent, don't trigger new run
       logger.info(`Schedule ${scheduleId} has recent execution, skipping`);
       continue;
     } else {
       // Execution is stale, mark as timeout
       await staleSnapshot.docs[0].ref.update({
         status: "timeout",
         error: {
           message: "Execution timed out after 15 minutes",
           code: "TIMEOUT"
         }
       });
     }
   }
   ```

3. **Improve lock mechanism**:
   - Extend lock timeout from 5 minutes to 15 minutes
   - Only clear lock when execution completes or times out

### Phase 4: Additional Safeguards

1. **Add validation when creating schedules**:

   - Frontend: Validate that `interval_minutes` is >= 1 and <= 1440
   - Backend: Add validation in schedule creation endpoint

2. **Add monitoring/logging**:

   - Log when schedules are skipped due to in-progress executions
   - Log when executions are marked as timeout
   - Add metrics for schedule execution success/failure rates

3. **Add manual recovery**:
   - Add UI button to manually mark stuck executions as "timeout"
   - Add admin function to reset stuck schedules

## Implementation Order

1. **Phase 1** (Frequency Calculation) - Fixes the root cause of incorrect scheduling
2. **Phase 3** (Prevent Re-triggering) - Prevents the symptom of rapid triggering
3. **Phase 2** (Status Updates) - Fixes the display issue and provides proper status tracking
4. **Phase 4** (Safeguards) - Prevents future issues

## Testing Plan

1. **Test frequency calculation**:

   - Create schedule with 120 minutes interval
   - Verify next_run_at is exactly 120 minutes from now
   - After first run, verify second run is 120 minutes after first
   - Test with 180 minutes, 60 minutes, 30 minutes

2. **Test execution status updates**:

   - Trigger a schedule run
   - Verify execution status changes from "started" to final status when run completes
   - Test with successful run, failed run, and timeout scenario

3. **Test re-triggering prevention**:

   - Start a long-running integrity run
   - Verify schedule doesn't trigger again until run completes or times out
   - Verify timeout mechanism works after 15 minutes

4. **Test edge cases**:
   - Schedule with very short interval (1 minute)
   - Schedule with very long interval (24 hours)
   - Multiple schedules running simultaneously
   - Schedule with max_runs limit

## Rollout Plan

1. Deploy Phase 1 fix first (frequency calculation)
2. Monitor for 24 hours to ensure schedules are running at correct intervals
3. Deploy Phase 3 fix (prevent re-triggering)
4. Deploy Phase 2 fix (status updates)
5. Clean up existing stuck executions manually or via script
6. Deploy Phase 4 safeguards
