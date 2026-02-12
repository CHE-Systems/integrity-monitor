# Updating Google Service Account Key

## Important Notes

- **For Cloud Run**: The service account credentials are managed via IAM, not JSON files. Cloud Run uses the service account attached to the service (`integrity-runner@data-integrity-monitor.iam.gserviceaccount.com`). You don't need to update anything in Cloud Run.
- **For Local Development**: The JSON file is only used locally via the `GOOGLE_APPLICATION_CREDENTIALS` environment variable.

## Steps to Update the Service Account Key

### Option 1: Create a New Key for the Existing Service Account

1. Go to [Google Cloud Console - Service Accounts](https://console.cloud.google.com/iam-admin/serviceaccounts?project=data-integrity-monitor)
2. Find the service account: `firebase-adminsdk-fbsvc@data-integrity-monitor.iam.gserviceaccount.com`
3. Click on the service account
4. Go to the "Keys" tab
5. Click "Add Key" → "Create new key"
6. Choose "JSON" format
7. Download the key file
8. Replace `backend/data-integrity-service-account2.json` with the new file

### Option 2: Delete Old Key and Create New One

1. Go to [Google Cloud Console - Service Accounts](https://console.cloud.google.com/iam-admin/serviceaccounts?project=data-integrity-monitor)
2. Find the service account: `firebase-adminsdk-fbsvc@data-integrity-monitor.iam.gserviceaccount.com`
3. Click on the service account
4. Go to the "Keys" tab
5. Delete the old key (the one that was leaked)
6. Click "Add Key" → "Create new key"
7. Choose "JSON" format
8. Download the key file
9. Replace `backend/data-integrity-service-account2.json` with the new file

## Verify the Update

After updating the file, verify it works:

```bash
# Set the environment variable (if not already set in .env)
export GOOGLE_APPLICATION_CREDENTIALS="backend/data-integrity-service-account2.json"

# Test that it works
python3 -c "from google.auth import default; creds, project = default(); print(f'Success! Project: {project}')"
```

## Security Reminders

✅ **DO:**
- Keep service account JSON files in `.gitignore` (already configured)
- Use environment variables to reference the file path
- Rotate keys immediately if they're leaked
- Use Secret Manager for production secrets

❌ **DON'T:**
- Commit service account JSON files to git
- Hardcode credentials in source code
- Share service account keys in logs or documentation
- Use the same key across multiple environments without rotation

## For Cloud Run Deployment

Cloud Run doesn't use the JSON file. It uses the service account attached to the Cloud Run service. To verify or update the Cloud Run service account:

```bash
# Check current service account
gcloud run services describe integrity-runner \
  --region us-central1 \
  --project data-integrity-monitor \
  --format="value(spec.template.spec.serviceAccountName)"

# The service account should be: integrity-runner@data-integrity-monitor.iam.gserviceaccount.com
```

If you need to rotate the Cloud Run service account key, you would need to create a new service account and update the Cloud Run service to use it, but typically you just rotate the JSON key for local development.

