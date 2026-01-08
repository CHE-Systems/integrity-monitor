#!/bin/bash
# Fix the CLOUD_RUN_SERVICE_URL secret to point to the correct backend
# This fixes the CORS error where frontend is pointing to che-toolkit-api

set -e

PROJECT_ID="data-integrity-monitor"
REGION="us-central1"
SERVICE_NAME="integrity-runner"

echo "🔧 Fixing CLOUD_RUN_SERVICE_URL secret for data-integrity-monitor"
echo "Project: ${PROJECT_ID}"
echo "Service: ${SERVICE_NAME}"
echo "Region: ${REGION}"
echo ""

# Get the correct Cloud Run service URL
echo "Fetching Cloud Run service URL..."
SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" \
    --region="$REGION" \
    --project="$PROJECT_ID" \
    --format="value(status.url)" 2>/dev/null || echo "")

if [ -z "$SERVICE_URL" ]; then
    echo "❌ Error: Could not fetch Cloud Run service URL"
    echo "   Make sure:"
    echo "   1. You're authenticated: gcloud auth login"
    echo "   2. The service exists: gcloud run services list --project=$PROJECT_ID"
    echo "   3. You have permissions to view the service"
    exit 1
fi

echo "✅ Found Cloud Run service URL: $SERVICE_URL"
echo ""

# Check current secret value
SECRET_NAME="CLOUD_RUN_SERVICE_URL"
CURRENT_VALUE=$(gcloud secrets versions access latest --secret="$SECRET_NAME" --project="$PROJECT_ID" 2>/dev/null || echo "")

if [ -n "$CURRENT_VALUE" ]; then
    echo "Current secret value: $CURRENT_VALUE"
    if [ "$CURRENT_VALUE" = "$SERVICE_URL" ]; then
        echo "✅ Secret already has the correct value!"
        exit 0
    else
        echo "⚠️  Secret has incorrect value. Updating..."
    fi
else
    echo "📝 Secret doesn't exist. Creating..."
fi

# Update the secret
echo ""
echo "Updating secret..."
echo -n "$SERVICE_URL" | gcloud secrets versions add "$SECRET_NAME" \
    --data-file=- \
    --project="$PROJECT_ID"

echo ""
echo "✅ Secret updated successfully!"
echo "   Secret: $SECRET_NAME"
echo "   Value: $SERVICE_URL"
echo ""
echo "Next steps:"
echo "  1. Rebuild the frontend: cd frontend && ./build-with-secrets.sh"
echo "  2. Redeploy the frontend: cd deploy && ./deploy.sh --frontend"
echo ""
