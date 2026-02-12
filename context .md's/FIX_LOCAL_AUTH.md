# Fix Local Authentication

## Problem

The backend is trying to use a deleted service account file because `GOOGLE_APPLICATION_CREDENTIALS` is still set in `backend/.env`.

## Quick Fix

**Option 1: Remove the line from backend/.env (Recommended)**

Edit `backend/.env` and either:

- Remove the line: `GOOGLE_APPLICATION_CREDENTIALS="data-integrity-service-account2.json"`
- Or comment it out: `# GOOGLE_APPLICATION_CREDENTIALS="data-integrity-service-account2.json"`

Then restart your backend:

```bash
./stop.sh
./run.sh
```

**Option 2: Unset the environment variable**

If you can't edit the .env file right now, you can unset it before starting:

```bash
unset GOOGLE_APPLICATION_CREDENTIALS
./run.sh
```

Or add this to your shell profile to always unset it:

```bash
export GOOGLE_APPLICATION_CREDENTIALS=""
```

## Verify ADC is Set Up

Make sure Application Default Credentials are configured:

```bash
gcloud auth application-default login
```

Verify it works:

```bash
gcloud auth application-default print-access-token
```

If this command works, ADC is properly configured.

## After Fixing

1. Restart the backend: `./stop.sh && ./run.sh`
2. Try accessing the frontend again
3. Authentication should work now

## Why This Happened

When we deleted `backend/data-integrity-service-account2.json`, the `backend/.env` file still had a reference to it. The backend tries to use that file first, and when it doesn't exist, falls back to ADC. However, the error handling wasn't perfect, causing the authentication to fail.

The fix ensures that if the file doesn't exist, it immediately and properly falls back to Application Default Credentials.
