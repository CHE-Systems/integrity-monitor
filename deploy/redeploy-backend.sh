#!/bin/bash
# Quick redeploy script to fix merge conflict in deployed container

set -e

PROJECT_ID=${GCP_PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || echo "")}
if [ -z "$PROJECT_ID" ]; then
    if [ -f "../.firebaserc" ]; then
        PROJECT_ID=$(grep -o '"default":\s*"[^"]*"' "../.firebaserc" | cut -d'"' -f4)
    fi
fi

if [ -z "$PROJECT_ID" ]; then
    echo "Error: PROJECT_ID not found"
    exit 1
fi

REGION=${CLOUD_RUN_REGION:-us-central1}
SERVICE_NAME="integrity-runner"

echo "Redeploying backend to fix merge conflict..."
echo "Project: ${PROJECT_ID}"
echo "Region: ${REGION}"
echo ""

# Deploy from source (this will build a new container with current code)
echo "Deploying from source..."
cd ..

gcloud run deploy "${SERVICE_NAME}" \
  --source backend \
  --region "${REGION}" \
  --platform managed \
  --allow-unauthenticated \
  --memory 4Gi \
  --cpu 2 \
  --timeout 30m \
  --min-instances 0 \
  --max-instances 10 \
  --concurrency 80 \
  --set-env-vars "ALLOWED_ORIGINS=*,AIRTABLE_MIN_REQUEST_INTERVAL=0.05" \
  --set-secrets "AIRTABLE_PAT=AIRTABLE_PAT:latest" \
  --set-secrets "API_AUTH_TOKEN=API_AUTH_TOKEN:latest" \
  --set-secrets "OPENAI_API_KEY=OPENAI_API_KEY:latest" \
  --project "${PROJECT_ID}"

echo ""
echo "✅ Backend redeployed successfully!"
echo ""
echo "The new revision should start without the merge conflict error."
