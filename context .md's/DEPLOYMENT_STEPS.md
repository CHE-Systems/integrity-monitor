# Deployment Steps - Security Remediation

This document outlines the steps needed to deploy the security remediation changes.

## Prerequisites

1. **Google Cloud CLI authenticated:**

   ```bash
   gcloud auth login
   gcloud config set project data-integrity-monitor
   ```

2. **Firebase CLI authenticated:**

   ```bash
   firebase login
   ```

3. **All secrets rotated** (see SECURITY_REMEDIATION.md for details)

## Step 1: Create Secrets in Secret Manager

```bash
cd deploy
./create-secrets.sh
```

This will create/update all 8 secrets:

- `AIRTABLE_PAT`
- `API_AUTH_TOKEN`
- `FIREBASE_API_KEY`
- `FIREBASE_AUTH_DOMAIN`
- `FIREBASE_PROJECT_ID`
- `FIREBASE_STORAGE_BUCKET`
- `FIREBASE_MESSAGING_SENDER_ID`
- `FIREBASE_APP_ID`

**Note:** The script reads from `backend/.env` and `frontend/.env.local`. Make sure these files contain the values you want to use (or provide them interactively).

## Step 2: Deploy Cloud Functions

```bash
firebase deploy --only functions
```

This will:

- Deploy the updated `functions/index.js` with `defineSecret()` support
- Automatically grant the Cloud Functions service account access to `API_AUTH_TOKEN` secret
- Make the secret available at runtime via `apiAuthToken.value()`

## Step 3: Configure Cloud Run Service

```bash
cd deploy
./configure-cloud-run-secrets.sh
```

Or manually:

```bash
gcloud run services update integrity-runner \
  --update-secrets=AIRTABLE_PAT=AIRTABLE_PAT:latest \
  --update-secrets=API_AUTH_TOKEN=API_AUTH_TOKEN:latest \
  --region=us-central1 \
  --project=data-integrity-monitor
```

This injects secrets as environment variables into the Cloud Run service.

## Step 4: Build Frontend with Secrets

For production builds, use the Secret Manager integration:

```bash
USE_SECRET_MANAGER=true ./build-frontend.sh
```

Or use the dedicated script:

```bash
cd frontend
./build-with-secrets.sh
```

This fetches Firebase config from Secret Manager and injects it as `VITE_*` env vars during the build.

## Step 5: Deploy Frontend

```bash
firebase deploy --only hosting
```

## Step 6: Verify Deployment

### Test Cloud Run:

```bash
curl -H "Authorization: Bearer $(gcloud auth print-identity-token)" \
  https://integrity-runner-scp7iaco4q-uc.a.run.app/health
```

### Test Cloud Functions:

```bash
# Check function logs
firebase functions:log

# Manually trigger scheduled scan (if needed)
gcloud functions call runScheduledScans --region=us-central1
```

### Test Frontend:

1. Open the deployed frontend URL
2. Verify Firebase Auth works
3. Check that dashboard loads correctly
4. Test a manual scan run

## Troubleshooting

### Cloud Run can't access secrets:

- Verify service account has `roles/secretmanager.secretAccessor` role
- Check secret names match exactly (case-sensitive)
- Verify secrets exist: `gcloud secrets list`

### Cloud Functions can't access secrets:

- Verify `defineSecret()` is used correctly in `functions/index.js`
- Check function logs: `firebase functions:log`
- Ensure secret was created: `firebase functions:secrets:access API_AUTH_TOKEN`

### Frontend build fails:

- Verify all 6 Firebase secrets exist in Secret Manager
- Check you have permission to access secrets: `gcloud secrets versions access latest --secret="FIREBASE_API_KEY"`
- Fall back to `.env.local` for local development

## Rollback Plan

If issues occur:

1. **Rollback Cloud Functions:**

   ```bash
   # Revert to previous version
   firebase functions:rollback
   ```

2. **Rollback Cloud Run:**

   ```bash
   # Remove secret references (use env vars instead temporarily)
   gcloud run services update integrity-runner \
     --remove-secrets=AIRTABLE_PAT,API_AUTH_TOKEN \
     --update-env-vars=AIRTABLE_PAT="$(gcloud secrets versions access latest --secret=AIRTABLE_PAT)",API_AUTH_TOKEN="$(gcloud secrets versions access latest --secret=API_AUTH_TOKEN)" \
     --region=us-central1
   ```

3. **Rollback Frontend:**
   ```bash
   # Rebuild with .env.local
   cd frontend
   npm run build
   firebase deploy --only hosting
   ```

## Post-Deployment Checklist

- [ ] Cloud Run health endpoint responds
- [ ] Cloud Functions can access `API_AUTH_TOKEN` secret
- [ ] Backend can access Airtable using `AIRTABLE_PAT` from Secret Manager
- [ ] Frontend loads without errors
- [ ] Firebase Auth works correctly
- [ ] Manual scan run completes successfully
- [ ] Scheduled scans continue to work
- [ ] No secret-related errors in Cloud Logging
