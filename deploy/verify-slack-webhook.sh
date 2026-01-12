#!/bin/bash
# Verify that slack-webhook-url secret exists and has a value

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

SECRET_NAME="slack-webhook-url"

echo "Verifying slack-webhook-url secret in project: ${PROJECT_ID}"
echo ""

# Check if secret exists
if gcloud secrets describe "$SECRET_NAME" --project="$PROJECT_ID" &>/dev/null; then
    echo "✅ Secret exists: ${SECRET_NAME}"
    
    # Get the latest version
    LATEST_VERSION=$(gcloud secrets versions list "$SECRET_NAME" \
        --project="$PROJECT_ID" \
        --limit=1 \
        --format="value(name)" 2>/dev/null | head -1)
    
    if [ -n "$LATEST_VERSION" ]; then
        echo "✅ Latest version found: ${LATEST_VERSION}"
        
        # Get the value (masked)
        VALUE=$(gcloud secrets versions access "$LATEST_VERSION" \
            --project="$PROJECT_ID" 2>/dev/null)
        
        if [ -n "$VALUE" ]; then
            # Mask the URL for display (show first 20 and last 10 chars)
            MASKED=$(echo "$VALUE" | sed 's|\(.\{20\}\).*\(.\{10\}\)|\1...\2|')
            echo "✅ Secret has a value (masked): ${MASKED}"
            echo ""
            echo "Secret is configured correctly!"
        else
            echo "⚠️  Secret exists but has no value"
            exit 1
        fi
    else
        echo "⚠️  Secret exists but has no versions"
        exit 1
    fi
else
    echo "❌ Secret does not exist: ${SECRET_NAME}"
    echo ""
    echo "Create it with:"
    echo "  gcloud secrets create ${SECRET_NAME} --replication-policy=automatic --project=${PROJECT_ID}"
    echo ""
    echo "Then add your webhook URL:"
    echo "  echo -n 'YOUR_WEBHOOK_URL' | gcloud secrets versions add ${SECRET_NAME} --data-file=- --project=${PROJECT_ID}"
    exit 1
fi

