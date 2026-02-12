# Scheduling Setup Guide

This document describes the configuration required for the scheduling feature.

## Overview

The scheduling feature allows you to configure automated integrity scans that run on a schedule, even when no one is using the app. It consists of:

1. **Frontend UI**: Scheduling page to create and manage schedule groups and schedules
2. **Firestore Collections**: Data storage for schedule groups, schedules, and execution history
3. **Cloud Function**: Scheduled function that runs every minute to check for due schedules and trigger backend runs

## Required Environment Variables

The scheduled Cloud Function requires the following environment variables to be set:

### `INTEGRITY_RUNNER_URL`

The base URL of your backend API (FastAPI) that handles integrity runs.

**Example:**

```
INTEGRITY_RUNNER_URL=https://your-backend-url.run.app
```

For local development:

```
INTEGRITY_RUNNER_URL=http://localhost:8080
```

### `API_AUTH_TOKEN`

The authentication token used to authenticate requests from the Cloud Function to the backend API. This should match the `API_AUTH_TOKEN` environment variable configured in your backend.

**Example:**

```
API_AUTH_TOKEN=your-secure-random-token-here
```

## Setting Environment Variables

### For Firebase Cloud Functions

You can set environment variables for Cloud Functions using the Firebase CLI:

```bash
# Set INTEGRITY_RUNNER_URL
firebase functions:config:set integrity_runner.url="https://your-backend-url.run.app"

# Set API_AUTH_TOKEN (use a secure random token)
firebase functions:config:set api_auth.token="your-secure-random-token-here"
```

Or using environment variables in `.env` file (for local development):

```bash
# In functions/.env
INTEGRITY_RUNNER_URL=https://your-backend-url.run.app
API_AUTH_TOKEN=your-secure-random-token-here
```

### For Production Deployment

For production, you should use Firebase Functions secrets (recommended for sensitive values):

```bash
# Set secrets (more secure than config)
firebase functions:secrets:set INTEGRITY_RUNNER_URL
firebase functions:secrets:set API_AUTH_TOKEN
```

Then update `functions/index.js` to use secrets:

```javascript
const INTEGRITY_RUNNER_URL = process.env.INTEGRITY_RUNNER_URL;
const API_AUTH_TOKEN = process.env.API_AUTH_TOKEN;
```

Note: The current implementation uses `process.env` which works with both config and secrets. For production, prefer secrets.

## Backend Configuration

Ensure your backend has the same `API_AUTH_TOKEN` configured:

```bash
# In backend/.env
API_AUTH_TOKEN=your-secure-random-token-here
```

The backend's `verify_cloud_scheduler_auth` middleware in `backend/middleware/auth.py` will accept requests authenticated with this token.

## Firestore Indexes

The scheduling feature requires a composite index on the `schedules` collection. This has been added to `firestore.indexes.json`:

```json
{
  "collectionGroup": "schedules",
  "queryScope": "COLLECTION",
  "fields": [
    {
      "fieldPath": "enabled",
      "order": "ASCENDING"
    },
    {
      "fieldPath": "next_run_at",
      "order": "ASCENDING"
    }
  ]
}
```

Deploy the indexes:

```bash
firebase deploy --only firestore:indexes
```

## Deployment Steps

1. **Install dependencies**:

   ```bash
   cd functions
   npm install
   ```

2. **Set environment variables** (see above)

3. **Deploy Firestore indexes**:

   ```bash
   firebase deploy --only firestore:indexes
   ```

4. **Deploy Cloud Functions**:

   ```bash
   firebase deploy --only functions
   ```

5. **Verify the scheduled function**:
   - Check Firebase Console → Functions
   - Verify `runScheduledScans` is deployed and enabled
   - Check logs to ensure it's running every minute

## Testing

1. Create a schedule group in the UI
2. Create a schedule with a time in the near future (e.g., 2 minutes from now)
3. Wait for the scheduled time
4. Check the schedule executions in the UI to see if the run was triggered
5. Check the backend logs to verify the run was started
6. Check Firestore `schedule_executions` collection for execution records

## Troubleshooting

### Schedules not running

1. **Check Cloud Function logs**:

   ```bash
   firebase functions:log --only runScheduledScans
   ```

2. **Verify environment variables are set**:

   ```bash
   firebase functions:config:get
   ```

3. **Check schedule is enabled** in Firestore:

   - Collection: `schedules`
   - Field: `enabled` should be `true`
   - Field: `next_run_at` should be in the past

4. **Verify backend is accessible** from Cloud Functions:
   - Test the `INTEGRITY_RUNNER_URL` endpoint
   - Verify `API_AUTH_TOKEN` matches backend configuration

### Backend authentication errors

- Ensure `API_AUTH_TOKEN` in Cloud Functions matches `API_AUTH_TOKEN` in backend
- Check backend logs for authentication errors
- Verify backend's `verify_cloud_scheduler_auth` middleware is working

### Firestore permission errors

- Ensure Firestore security rules allow authenticated users to read/write schedules
- Check that the Cloud Function has proper Firestore permissions

## Security Notes

- **Never commit `API_AUTH_TOKEN` to version control**
- Use Firebase Functions secrets for production deployments
- Rotate `API_AUTH_TOKEN` periodically
- Ensure Firestore security rules restrict access to authenticated users only
