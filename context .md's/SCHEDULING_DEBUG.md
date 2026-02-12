# Scheduling Debug Guide

## Quick Checks

### 1. Verify Cloud Function is Deployed

```bash
# Check if the function exists
firebase functions:list

# Check function logs
firebase functions:log --only runScheduledScans --limit 50
```

Look for:

- "Checking for due schedules" messages (should appear every minute)
- Any error messages about missing environment variables
- "Found X due schedule(s)" messages

### 2. Check Environment Variables

```bash
# Check if environment variables are set
firebase functions:config:get

# Or if using secrets
firebase functions:secrets:access INTEGRITY_RUNNER_URL
firebase functions:secrets:access API_AUTH_TOKEN
```

### 3. Verify Schedule in Firestore

In Firebase Console → Firestore, check your schedule document:

1. **Collection**: `schedules`
2. **Find your schedule document**
3. **Check these fields**:
   - `enabled`: Should be `true`
   - `next_run_at`: Should be a Timestamp that is in the past (or very recent)
   - `timezone`: Should match what you selected
   - `time_of_day`: Should be in 24-hour format (e.g., "14:53" for 2:53 PM)

### 4. Check Schedule Executions

1. **Collection**: `schedule_executions`
2. Look for any execution records for your schedule
3. Check the `status` field:
   - `"started"`: Execution was triggered
   - `"error"`: Execution failed (check `error` field for details)

## Common Issues

### Issue: `next_run_at` is in the future when it should be in the past

**Cause**: Frontend timezone conversion is incorrect.

**Fix**: The Cloud Function will recompute `next_run_at` correctly when it processes the schedule. However, if the initial value is too far in the future, it won't be picked up until that time.

**Workaround**: Manually update the schedule in Firestore:

1. Go to your schedule document
2. Set `next_run_at` to a Timestamp that's 1-2 minutes in the past
3. The Cloud Function should pick it up on the next run (within 1 minute)

### Issue: Cloud Function not running

**Check**:

```bash
# Verify the function is deployed
firebase functions:list | grep runScheduledScans

# Check if it's enabled in Firebase Console
# Go to: Firebase Console → Functions → runScheduledScans
```

**Fix**: Deploy the function:

```bash
cd functions
npm install
firebase deploy --only functions:runScheduledScans
```

### Issue: Environment variables not set

**Symptoms**: Cloud Function logs show:

- "INTEGRITY_RUNNER_URL environment variable not set"
- "API_AUTH_TOKEN environment variable not set"

**Fix**: Set the environment variables (see SCHEDULING_SETUP.md)

### Issue: Schedule is locked

**Cause**: A previous execution attempt failed and left a lock.

**Fix**: In Firestore, set `lock` to `null` on your schedule document, or wait 5 minutes for the lock to expire.

## Testing

To test immediately:

1. **Create a test schedule** for 1-2 minutes in the future
2. **Wait for the time to pass**
3. **Check Cloud Function logs** to see if it was picked up
4. **Check `schedule_executions` collection** for execution records

## Manual Trigger (for testing)

You can manually trigger the Cloud Function for testing:

```bash
# Using Firebase CLI (if you have the function URL)
curl -X POST "https://YOUR_REGION-YOUR_PROJECT.cloudfunctions.net/runScheduledScans" \
  -H "Authorization: Bearer $(firebase auth:print-access-token)"
```

Or create a test schedule with `next_run_at` set to the current time minus 1 minute.
