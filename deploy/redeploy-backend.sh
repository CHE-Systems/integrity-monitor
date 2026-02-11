#!/bin/bash
# Quick redeploy script to fix merge conflict in deployed container

set -e

# Hardcoded to prevent accidental deployment to wrong project
PROJECT_ID="data-integrity-monitor"

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
  --memory 2Gi \
  --cpu 2 \
  --no-cpu-throttling \
  --timeout 30m \
  --min-instances 0 \
  --max-instances 10 \
  --concurrency 5 \
  --set-env-vars "ALLOWED_ORIGINS=*,AIRTABLE_MIN_REQUEST_INTERVAL=0.05" \
  --set-secrets "AIRTABLE_PAT=AIRTABLE_PAT:latest" \
  --set-secrets "API_AUTH_TOKEN=API_AUTH_TOKEN:latest" \
  --set-secrets "OPENAI_API_KEY=OPENAI_API_KEY:latest" \
  --project "${PROJECT_ID}"

echo ""
echo "✅ Backend redeployed successfully!"
echo ""
echo "The new revision should start without the merge conflict error."
