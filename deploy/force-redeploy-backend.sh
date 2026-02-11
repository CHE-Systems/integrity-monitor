#!/bin/bash
# Force redeploy backend with no cache to ensure latest code is deployed

set -e

# Hardcoded to prevent accidental deployment to wrong project
PROJECT_ID="data-integrity-monitor"

REGION=${CLOUD_RUN_REGION:-us-central1}
SERVICE_NAME="integrity-runner"

# Get the script directory and project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "Force redeploying backend (no cache)..."
echo "Project: ${PROJECT_ID}"
echo "Region: ${REGION}"
echo "Service: ${SERVICE_NAME}"
echo "Project Root: ${PROJECT_ROOT}"
echo ""

# Change to project root for all operations
cd "${PROJECT_ROOT}"

# Verify the code change is present
echo "Verifying code changes..."
if grep -q "AIRTABLE_API_KEY" backend/writers/airtable_writer.py 2>/dev/null; then
    echo "❌ ERROR: Code still contains AIRTABLE_API_KEY references!"
    echo "   Please ensure all changes have been saved."
    exit 1
fi

if ! grep -q "AIRTABLE_PAT" backend/writers/airtable_writer.py 2>/dev/null; then
    echo "❌ ERROR: Code does not contain AIRTABLE_PAT!"
    echo "   Please ensure the code has been updated."
    exit 1
fi

echo "✅ Code changes verified"
echo ""

# Deploy using Cloud Build to force clean rebuild
echo "Building and deploying using Cloud Build (forces clean rebuild)..."
echo ""

# First, submit a Cloud Build that will build with --no-cache
echo "Step 1: Building container image with --no-cache..."
gcloud builds submit backend \
  --config deploy/cloudbuild.yaml \
  --project "${PROJECT_ID}" \
  --substitutions=_REGION="${REGION}",_SERVICE_NAME="${SERVICE_NAME}",SHORT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "manual-$(date +%s)") \
  || {
    echo ""
    echo "Cloud Build failed. Trying direct deployment..."
    echo ""
    # Fallback to direct deployment (we're already in PROJECT_ROOT)
    gcloud run deploy "${SERVICE_NAME}" \
      --source backend \
      --region "${REGION}" \
      --platform managed \
      --allow-unauthenticated \
      --memory 4Gi \
      --cpu 2 \
      --timeout 30m \
      --min-instances 1 \
      --max-instances 10 \
      --concurrency 80 \
      --set-env-vars "ALLOWED_ORIGINS=*,AIRTABLE_MIN_REQUEST_INTERVAL=0.05" \
      --set-secrets "AIRTABLE_PAT=AIRTABLE_PAT:latest" \
      --set-secrets "API_AUTH_TOKEN=API_AUTH_TOKEN:latest" \
      --set-secrets "OPENAI_API_KEY=OPENAI_API_KEY:latest" \
      --project "${PROJECT_ID}"
  }

echo ""
echo "✅ Backend force redeployed!"
echo ""
echo "Waiting 10 seconds for new revision to start..."
sleep 10

# Get the latest revision
LATEST_REVISION=$(gcloud run revisions list \
  --service="${SERVICE_NAME}" \
  --region="${REGION}" \
  --project="${PROJECT_ID}" \
  --limit=1 \
  --format="value(name)" 2>/dev/null || echo "")

if [ -n "$LATEST_REVISION" ]; then
    echo "Latest revision: ${LATEST_REVISION}"
    echo ""
    echo "Check logs with:"
    echo "  gcloud logging read \"resource.type=cloud_run_revision AND resource.labels.revision_name=${LATEST_REVISION}\" --limit=20 --project=${PROJECT_ID}"
fi

