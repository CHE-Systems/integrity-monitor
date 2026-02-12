# Pending Environment Setup

## Cloud Run Deployment

### Google Cloud Project

- [ ] Set `GCP_PROJECT_ID` - Your Google Cloud project ID
- [ ] Set `CLOUD_RUN_REGION` - Region for Cloud Run (default: `us-central1`)
- [ ] Set `CLOUD_RUN_SERVICE_URL` - Cloud Run service URL (auto-detected if not set)

### Secret Manager Secrets

All secrets must be created in Google Cloud Secret Manager:

- [ ] `AIRTABLE_PAT` - Airtable Personal Access Token
- [ ] `AT_STUDENTS_BASE` - Students base ID
- [ ] `AT_STUDENTS_TABLE` - Students table ID
- [ ] `AT_PARENTS_BASE` - Parents base ID
- [ ] `AT_PARENTS_TABLE` - Parents table ID
- [ ] `AT_CONTRACTORS_BASE` - Contractors base ID
- [ ] `AT_CONTRACTORS_TABLE` - Contractors table ID
- [ ] `AT_CLASSES_BASE` - Classes base ID
- [ ] `AT_CLASSES_TABLE` - Classes table ID
- [ ] `AT_ATTENDANCE_BASE` - Attendance base ID
- [ ] `AT_ATTENDANCE_TABLE` - Attendance table ID
- [ ] `AT_TRUTH_BASE` - Truth base ID
- [ ] `AT_TRUTH_TABLE` - Truth table ID
- [ ] `AT_PAYMENTS_BASE` - Payments base ID
- [ ] `AT_PAYMENTS_TABLE` - Payments table ID
- Firebase service account JSON (content or path)

### Service Accounts

Service accounts are created by `deploy/iam-setup.sh`:

- [ ] `integrity-runner@PROJECT.iam.gserviceaccount.com` - Cloud Run service account
  - Needs: `roles/datastore.user`, `roles/secretmanager.secretAccessor`
- [ ] `cloud-scheduler@PROJECT.iam.gserviceaccount.com` - Cloud Scheduler invoker
  - Needs: `roles/run.invoker` on Cloud Run service

### Monitoring (Optional)

- [ ] `SLACK_WEBHOOK_URL` - Slack webhook for alerts
- [ ] `ALERT_EMAIL` - Email address for alert notifications

### Artifact Registry

- [ ] Create Artifact Registry repository: `integrity-monitor` in your region
  ```bash
  gcloud artifacts repositories create integrity-monitor \
    --repository-format=docker \
    --location=us-central1
  ```
