#!/bin/bash
# Create Secret Manager secrets from backend/.env file or interactively

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

ENV_FILE="../backend/.env"
SECRETS=(
    "AIRTABLE_PAT"
    "API_AUTH_TOKEN"
    "OPENAI_API_KEY"
)

echo "Creating secrets in Secret Manager for project: ${PROJECT_ID}"
echo ""
echo "Note: slack-webhook-url is protected and will not be modified by this script."
echo "      It should be managed via the API endpoint or manually."
echo ""

# Check if .env file exists
if [ -f "$ENV_FILE" ]; then
    echo "Found .env file: ${ENV_FILE}"
    echo "Loading values from .env file..."
    echo ""
    
    # Source the .env file
    set -a
    source "$ENV_FILE"
    set +a
else
    echo "No .env file found at: ${ENV_FILE}"
    echo "You'll need to provide values interactively or create the .env file first."
    echo ""
fi

# Function to create or update a secret
create_secret() {
    local secret_name=$1
    local secret_value=$2
    
    # PROTECTED: Never touch slack-webhook-url - it's managed separately via the API
    if [ "$secret_name" = "slack-webhook-url" ]; then
        echo "⚠  ${secret_name}: Protected secret - skipping (managed via API)"
        return 1
    fi
    
    if [ -z "$secret_value" ]; then
        echo "⚠  ${secret_name}: No value found, skipping..."
        return 1
    fi
    
    # Check if secret exists
    if gcloud secrets describe "$secret_name" --project="$PROJECT_ID" &>/dev/null; then
        echo "📝 ${secret_name}: Secret exists, creating new version..."
        echo -n "$secret_value" | gcloud secrets versions add "$secret_name" \
            --data-file=- \
            --project="$PROJECT_ID" &>/dev/null
        echo "   ✓ Updated with new version"
    else
        echo "✨ ${secret_name}: Creating new secret..."
        echo -n "$secret_value" | gcloud secrets create "$secret_name" \
            --data-file=- \
            --replication-policy="automatic" \
            --project="$PROJECT_ID" &>/dev/null
        echo "   ✓ Created successfully"
    fi
}

# Create secrets
CREATED=0
SKIPPED=0

for secret in "${SECRETS[@]}"; do
    # Get value from environment (may be from .env file or already set)
    value="${!secret}"
    
    if create_secret "$secret" "$value"; then
        CREATED=$((CREATED + 1))
    else
        SKIPPED=$((SKIPPED + 1))
    fi
done

echo ""
echo "════════════════════════════════════════"
echo "Summary:"
echo "  Created/Updated: ${CREATED}"
echo "  Skipped: ${SKIPPED}"
echo "  Total: ${#SECRETS[@]}"
echo ""

if [ $SKIPPED -gt 0 ]; then
    echo "⚠  Some secrets were skipped because no values were found."
    echo "   Make sure your .env file contains all required variables:"
    for secret in "${SECRETS[@]}"; do
        value="${!secret}"
        if [ -z "$value" ]; then
            echo "     - ${secret}"
        fi
    done
    echo ""
fi

echo "✓ Secret creation complete!"
echo ""
echo "You can now retry the deployment:"
echo "  ./deploy/deploy.sh --backend"

