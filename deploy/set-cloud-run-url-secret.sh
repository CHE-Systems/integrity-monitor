#!/bin/bash
# Set CLOUD_RUN_SERVICE_URL secret in Secret Manager
# This secret is used by frontend/build-with-secrets.sh to set VITE_API_BASE

set -e

PROJECT_ID=${GCP_PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || echo "")}
if [ -z "$PROJECT_ID" ]; then
    if [ -f "../.firebaserc" ]; then
        PROJECT_ID=$(grep -o '"default":\s*"[^"]*"' "../.firebaserc" | cut -d'"' -f4)
    fi
fi

if [ -z "$PROJECT_ID" ]; then
    echo "Error: PROJECT_ID not found"
    echo "Set GCP_PROJECT_ID environment variable or configure gcloud"
    exit 1
fi

REGION=${CLOUD_RUN_REGION:-us-central1}
SERVICE_NAME="integrity-runner"

echo "Setting CLOUD_RUN_SERVICE_URL secret for project: ${PROJECT_ID}"
echo ""

# Try to get URL from gcloud first
SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" \
    --region="$REGION" \
    --project="$PROJECT_ID" \
    --format="value(status.url)" 2>/dev/null || echo "")

if [ -z "$SERVICE_URL" ]; then
    echo "Error: Could not fetch Cloud Run service URL"
    echo "   Service: $SERVICE_NAME"
    echo "   Region: $REGION"
    echo "   Project: $PROJECT_ID"
    echo ""
    echo "Please provide the Cloud Run service URL manually:"
    read -p "Cloud Run Service URL: " SERVICE_URL
    
    if [ -z "$SERVICE_URL" ]; then
        echo "Error: No URL provided"
        exit 1
    fi
fi

echo "Cloud Run Service URL: $SERVICE_URL"
echo ""

# Create or update the secret
SECRET_NAME="CLOUD_RUN_SERVICE_URL"

if gcloud secrets describe "$SECRET_NAME" --project="$PROJECT_ID" &>/dev/null; then
    echo "📝 Secret exists, creating new version..."
    echo -n "$SERVICE_URL" | gcloud secrets versions add "$SECRET_NAME" \
        --data-file=- \
        --project="$PROJECT_ID"
    echo "   ✓ Updated with new version"
else
    echo "✨ Creating new secret..."
    echo -n "$SERVICE_URL" | gcloud secrets create "$SECRET_NAME" \
        --data-file=- \
        --replication-policy="automatic" \
        --project="$PROJECT_ID"
    echo "   ✓ Created successfully"
fi

echo ""
echo "✅ Secret created/updated: $SECRET_NAME"
echo "   Value: $SERVICE_URL"
echo ""
echo "The frontend build script will now use this URL for VITE_API_BASE"

