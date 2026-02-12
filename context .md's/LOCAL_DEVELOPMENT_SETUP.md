# Local Development Setup - After Security Remediation

After removing the service account file, you need to set up Application Default Credentials (ADC) for local development.

## Quick Fix

Run this command to set up Application Default Credentials:

```bash
gcloud auth application-default login
```

This will:

1. Open a browser window for Google authentication
2. Store credentials locally for use by the Firebase Admin SDK
3. Allow the backend to verify Firebase tokens without a service account file

## Why This Is Needed

The backend uses Firebase Admin SDK to verify Firebase ID tokens from the frontend. Previously, it used a service account JSON file (`data-integrity-service-account2.json`), but that file was removed for security reasons.

For local development, Application Default Credentials (ADC) is the recommended approach. It uses your personal Google Cloud credentials instead of a service account file.

## Alternative: Use Service Account File (Not Recommended)

If you need to use a service account file for local development:

1. **Create a new service account key** (the old one was compromised):

   ```bash
   gcloud iam service-accounts keys create local-dev-sa-key.json \
     --iam-account=firebase-adminsdk-fbsvc@data-integrity-monitor.iam.gserviceaccount.com
   ```

2. **Set the environment variable:**

   ```bash
   export GOOGLE_APPLICATION_CREDENTIALS=local-dev-sa-key.json
   ```

3. **Add to `.gitignore`** (should already be there):

   ```bash
   echo "local-dev-sa-key.json" >> .gitignore
   ```

4. **NEVER COMMIT THIS FILE**

## Verify Setup

After running `gcloud auth application-default login`, restart your backend:

```bash
./stop.sh
./run.sh
```

Then try accessing the frontend again. The authentication should work now.

## Troubleshooting

### Error: "Firebase authentication not configured"

**Solution:** Run `gcloud auth application-default login`

### Error: "Invalid or expired Firebase token"

**Possible causes:**

1. ADC not set up - run `gcloud auth application-default login`
2. Token actually expired - refresh the frontend page to get a new token
3. Wrong project - ensure you're logged into the correct Google Cloud project

### Check if ADC is working:

```bash
# Test that credentials are available
gcloud auth application-default print-access-token
```

If this command works, ADC is set up correctly.

## Production vs Local Development

- **Production (Cloud Run):** Uses the service account attached to the Cloud Run service (no file needed)
- **Local Development:** Uses Application Default Credentials (via `gcloud auth application-default login`)

No service account files are needed in either case after this setup!
