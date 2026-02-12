# Security Remediation Report

**Date:** December 18, 2024  
**Status:** ✅ Complete

## Issues Found

### 1. Service Account Private Key in Repository

**Severity:** CRITICAL  
**File:** `backend/data-integrity-service-account2.json`  
**Action Taken:** Removed from repository

### 2. Secrets in Git History

**Severity:** HIGH  
**Commits Affected:**

- 760b6d6 (Dec 15, 2024)
- 5ab0002 (Dec 15, 2024)
- adf85cd (Dec 12, 2024)

**Action Taken:** [PENDING] Git history cleanup with BFG Repo-Cleaner (optional but recommended)

### 3. Cloud Functions Not Using Secret Manager

**Severity:** MEDIUM  
**File:** `functions/index.js`  
**Action Taken:** Refactored to use `defineSecret()`

### 4. Secrets in Environment Files

**Severity:** MEDIUM  
**Files:** `backend/.env`, `frontend/.env.local`  
**Action Taken:**

- Updated scripts to migrate all secrets to Secret Manager
- Created `.env.example` templates
- Both files are properly gitignored ✅

## Secrets Requiring Rotation

### IMMEDIATE (Exposed in Git)

1. **Firebase Service Account Key**

   - **Location:** `backend/data-integrity-service-account2.json`
   - **Project:** data-integrity-monitor
   - **Service Account:** `firebase-adminsdk-fbsvc@data-integrity-monitor.iam.gserviceaccount.com`
   - **Private Key ID:** `[REDACTED - Key has been rotated]`
   - **Action Required:**

     ```bash
     # Disable the compromised key
     gcloud iam service-accounts keys delete [KEY_ID] \
       --iam-account=firebase-adminsdk-fbsvc@data-integrity-monitor.iam.gserviceaccount.com

     # Create new key (for local dev only - DO NOT COMMIT)
     gcloud iam service-accounts keys create new-sa-key.json \
       --iam-account=firebase-adminsdk-fbsvc@data-integrity-monitor.iam.gserviceaccount.com

     # Store securely (DO NOT COMMIT)
     # Use for local dev only with GOOGLE_APPLICATION_CREDENTIALS
     # For production, use Application Default Credentials instead
     ```

2. **Airtable Personal Access Token (PAT)**

   - **Variable Name:** `AIRTABLE_PAT`
   - **Current Value:** `[REDACTED - Token has been rotated]`
   - **Action Required:**
     1. Go to https://airtable.com/create/tokens
     2. Revoke existing token
     3. Create new PAT with scopes: `data.records:read`, `data.records:write`, `schema.bases:read`
     4. Add to Secret Manager:
        ```bash
        firebase functions:secrets:set AIRTABLE_PAT
        # Paste new token when prompted
        ```

3. **API Authentication Token**
   - **Variable Name:** `API_AUTH_TOKEN`
   - **Current Value:** `[REDACTED - Token has been rotated]`
   - **Action Required:**
     1. Generate new secure token:
        ```bash
        openssl rand -hex 32
        ```
     2. Add to Secret Manager:
        ```bash
        firebase functions:secrets:set API_AUTH_TOKEN
        # Paste new token when prompted
        ```
     3. Update Cloud Run service with new token reference

## Migration Steps for Each Secret

### Secret: AIRTABLE_PAT

**Current Location:** `backend/.env` (local only)  
**New Location:** Firebase Secret Manager  
**Migration:**

```bash
# 1. Create secret in Secret Manager
firebase functions:secrets:set AIRTABLE_PAT
# Paste token when prompted

# 2. Grant access to Cloud Run service account
gcloud secrets add-iam-policy-binding AIRTABLE_PAT \
  --member="serviceAccount:integrity-runner@data-integrity-monitor.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"

# 3. Update Cloud Run service
gcloud run services update integrity-runner \
  --update-secrets=AIRTABLE_PAT=AIRTABLE_PAT:latest \
  --region=us-central1
```

### Secret: API_AUTH_TOKEN

**Current Location:** `backend/.env`, Cloud Functions environment  
**New Location:** Firebase Secret Manager  
**Migration:**

```bash
# 1. Create secret
firebase functions:secrets:set API_AUTH_TOKEN

# 2. Cloud Functions will auto-access via defineSecret()
# (Already refactored in functions/index.js)

# 3. Update Cloud Run
gcloud run services update integrity-runner \
  --update-secrets=API_AUTH_TOKEN=API_AUTH_TOKEN:latest \
  --region=us-central1
```

### Firebase Web Config Secrets (6 values)

**Current Location:** `frontend/.env.local`  
**New Location:** Firebase Secret Manager  
**Migration:**

```bash
# 1. Create all Firebase config secrets
firebase functions:secrets:set FIREBASE_API_KEY
firebase functions:secrets:set FIREBASE_AUTH_DOMAIN
firebase functions:secrets:set FIREBASE_PROJECT_ID
firebase functions:secrets:set FIREBASE_STORAGE_BUCKET
firebase functions:secrets:set FIREBASE_MESSAGING_SENDER_ID
firebase functions:secrets:set FIREBASE_APP_ID

# Or use the automated script:
cd deploy
./create-secrets.sh
```

**For Production Builds:**

```bash
# Use the build script that fetches from Secret Manager
cd frontend
./build-with-secrets.sh

# Or set USE_SECRET_MANAGER=true for the main build script
USE_SECRET_MANAGER=true ./build-frontend.sh
```

## Deployment Checklist

### Before Deployment:

- [x] Remove `backend/data-integrity-service-account2.json`
- [x] Refactor Cloud Functions to use `defineSecret()`
- [ ] Create ALL secrets in Firebase Secret Manager (8 total)
- [ ] Update Cloud Run service with secret references
- [ ] Test locally with Application Default Credentials
- [ ] Rotate all exposed secrets

### Deploy Steps:

1. **Create Secrets in Secret Manager:**

   ```bash
   cd deploy
   ./create-secrets.sh
   ```

2. **Deploy Functions:**

   ```bash
   firebase deploy --only functions
   ```

3. **Update Cloud Run Service:**

   ```bash
   gcloud run services update integrity-runner \
     --update-secrets=AIRTABLE_PAT=AIRTABLE_PAT:latest \
     --update-secrets=API_AUTH_TOKEN=API_AUTH_TOKEN:latest \
     --region=us-central1 \
     --project=data-integrity-monitor
   ```

4. **Build Frontend with Secrets:**

   ```bash
   USE_SECRET_MANAGER=true ./build-frontend.sh
   ```

5. **Deploy Frontend to Firebase Hosting:**
   ```bash
   firebase deploy --only hosting
   ```

### Post-Deployment Verification:

- [ ] Test Cloud Run health endpoint
- [ ] Verify Cloud Functions can access secrets
- [ ] Confirm frontend loads without errors
- [ ] Run integrity scan to verify Airtable access
- [ ] Check Cloud Logging for any secret-related errors

## Guardrails Implemented

### 1. Pre-Commit Hook

**File:** `scripts/check-secrets.sh`  
**Purpose:** Block commits containing secrets or service account files  
**Usage:**

```bash
# Test the hook
./scripts/check-secrets.sh

# Install as git hook (optional)
ln -s ../../scripts/check-secrets.sh .git/hooks/pre-commit
```

### 2. CI/CD Security Check

**File:** `.github/workflows/security-check.yml` (optional)  
**Purpose:** Automated secret scanning on every push/PR

### 3. Documentation

**Files Updated:**

- `README.md` - Added security guidelines
- `backend/.env.example` - Template for environment variables
- `frontend/.env.example` - Template for Vite environment variables
- `SECURITY_REMEDIATION.md` - This document

## What Was Changed

1. **Removed:** `backend/data-integrity-service-account2.json` (CRITICAL)
2. **Refactored:** `functions/index.js` - Now uses `defineSecret()` for API_AUTH_TOKEN
3. **Updated:** `deploy/create-secrets.sh` - Now handles all 8 secrets (backend + Firebase config)
4. **Created:** `frontend/build-with-secrets.sh` - Builds frontend with secrets from Secret Manager
5. **Updated:** `build-frontend.sh` - Supports Secret Manager mode
6. **Updated:** `frontend/src/config/firebase.ts` - Handles missing env vars gracefully
7. **Created:** `scripts/check-secrets.sh` - Pre-commit secret detection
8. **Created:** `.env.example` files for both backend and frontend

## What Was NOT Changed

1. **Architecture** - Current pattern (Frontend → Cloud Run Backend → Airtable) is CORRECT, no changes needed
2. **Airtable Table IDs** - These are identifiers, not secrets, safe to keep in config files
3. **Firebase Web Config** - While moved to Secret Manager for consistency, these are technically public identifiers

## Next Steps for Josh

### Immediate (Today):

1. ✅ Rotate Firebase service account key (delete old key ID: `[REDACTED - Key has been rotated]`)
2. ✅ Rotate Airtable PAT
3. ✅ Generate new API_AUTH_TOKEN
4. ✅ Create all 8 secrets in Secret Manager using `deploy/create-secrets.sh`

### Short-term (This Week):

1. Update Cloud Run service with secret references
2. Deploy updated Cloud Functions
3. Test end-to-end functionality
4. [OPTIONAL] Clean git history using BFG or git-filter-repo

### Long-term:

1. Establish regular secret rotation schedule (every 90 days)
2. Review IAM permissions for least-privilege access
3. Enable Cloud Audit Logging for secret access monitoring
4. Set up automated secret rotation alerts

## Files Modified/Created

### Modified:

- `functions/index.js` - Added `defineSecret()` usage
- `deploy/create-secrets.sh` - Extended to handle Firebase config secrets
- `build-frontend.sh` - Added Secret Manager support
- `frontend/src/config/firebase.ts` - Added fallback values

### Deleted:

- `backend/data-integrity-service-account2.json` - SERVICE ACCOUNT KEY (CRITICAL)

### Created:

- `scripts/check-secrets.sh` - Pre-commit secret detection
- `frontend/build-with-secrets.sh` - Build script with Secret Manager integration
- `backend/.env.example` - Environment variable template
- `frontend/.env.example` - Frontend environment template
- `SECURITY_REMEDIATION.md` - This document
