#!/bin/bash
# Build frontend with Firebase config secrets from Secret Manager

set -e

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

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

echo "Building frontend with secrets from Secret Manager..."
echo "Project: ${PROJECT_ID}"
echo "Working directory: $(pwd)"
echo ""

# Fetch Firebase config secrets from Secret Manager
echo "Fetching Firebase config secrets..."

export VITE_FIREBASE_API_KEY=$(gcloud secrets versions access latest --secret="FIREBASE_API_KEY" --project="$PROJECT_ID" 2>/dev/null || echo "")
export VITE_FIREBASE_AUTH_DOMAIN=$(gcloud secrets versions access latest --secret="FIREBASE_AUTH_DOMAIN" --project="$PROJECT_ID" 2>/dev/null || echo "")
export VITE_FIREBASE_PROJECT_ID=$(gcloud secrets versions access latest --secret="FIREBASE_PROJECT_ID" --project="$PROJECT_ID" 2>/dev/null || echo "")
export VITE_FIREBASE_STORAGE_BUCKET=$(gcloud secrets versions access latest --secret="FIREBASE_STORAGE_BUCKET" --project="$PROJECT_ID" 2>/dev/null || echo "")
export VITE_FIREBASE_MESSAGING_SENDER_ID=$(gcloud secrets versions access latest --secret="FIREBASE_MESSAGING_SENDER_ID" --project="$PROJECT_ID" 2>/dev/null || echo "")
export VITE_FIREBASE_APP_ID=$(gcloud secrets versions access latest --secret="FIREBASE_APP_ID" --project="$PROJECT_ID" 2>/dev/null || echo "")

# Fetch Cloud Run backend URL for API_BASE
echo "Fetching Cloud Run backend URL..."
REGION=${CLOUD_RUN_REGION:-us-central1}
SERVICE_NAME="integrity-runner"

# Priority order:
# 1. Environment variable CLOUD_RUN_SERVICE_URL
# 2. Secret Manager secret CLOUD_RUN_SERVICE_URL
# 3. gcloud query for service URL
# Never fall back to localhost in production builds

if [ -n "$CLOUD_RUN_SERVICE_URL" ]; then
  export VITE_API_BASE="$CLOUD_RUN_SERVICE_URL"
  echo "✅ Set VITE_API_BASE from CLOUD_RUN_SERVICE_URL env var: $CLOUD_RUN_SERVICE_URL"
else
  # Try to fetch from Secret Manager
  CLOUD_RUN_URL=$(gcloud secrets versions access latest --secret="CLOUD_RUN_SERVICE_URL" --project="$PROJECT_ID" 2>/dev/null || echo "")
  
  if [ -n "$CLOUD_RUN_URL" ]; then
    export VITE_API_BASE="$CLOUD_RUN_URL"
    echo "✅ Set VITE_API_BASE from Secret Manager: $CLOUD_RUN_URL"
  else
    # Try to fetch from gcloud
    CLOUD_RUN_URL=$(gcloud run services describe "$SERVICE_NAME" \
      --region="$REGION" \
      --project="$PROJECT_ID" \
      --format="value(status.url)" 2>/dev/null || echo "")

    if [ -n "$CLOUD_RUN_URL" ]; then
      export VITE_API_BASE="$CLOUD_RUN_URL"
      echo "✅ Set VITE_API_BASE from gcloud query: $CLOUD_RUN_URL"
    else
      echo "❌ Error: Could not determine Cloud Run URL for VITE_API_BASE"
      echo "   Tried:"
      echo "     1. CLOUD_RUN_SERVICE_URL environment variable (not set)"
      echo "     2. Secret Manager secret CLOUD_RUN_SERVICE_URL (not found)"
      echo "     3. gcloud query for service '$SERVICE_NAME' in region '$REGION' (failed)"
      echo ""
      echo "   To fix:"
      echo "     Option 1: Set CLOUD_RUN_SERVICE_URL environment variable"
      echo "     Option 2: Create secret: echo -n 'https://your-service.run.app' | gcloud secrets create CLOUD_RUN_SERVICE_URL --data-file=- --project=$PROJECT_ID"
      echo "     Option 3: Ensure gcloud is configured and service exists"
      echo ""
      echo "   Production builds require a valid Cloud Run URL. Exiting."
      exit 1
    fi
  fi
fi

# Validate that we're not using localhost in production
if [[ "$VITE_API_BASE" == *"localhost"* ]] || [[ "$VITE_API_BASE" == *"127.0.0.1"* ]]; then
  echo "❌ Error: VITE_API_BASE is set to localhost: $VITE_API_BASE"
  echo "   This is not allowed for production builds."
  echo "   Please set CLOUD_RUN_SERVICE_URL to the correct Cloud Run URL."
  exit 1
fi

echo ""

# Check if any secrets are missing
MISSING_SECRETS=()
[ -z "$VITE_FIREBASE_API_KEY" ] && MISSING_SECRETS+=("FIREBASE_API_KEY")
[ -z "$VITE_FIREBASE_AUTH_DOMAIN" ] && MISSING_SECRETS+=("FIREBASE_AUTH_DOMAIN")
[ -z "$VITE_FIREBASE_PROJECT_ID" ] && MISSING_SECRETS+=("FIREBASE_PROJECT_ID")
[ -z "$VITE_FIREBASE_STORAGE_BUCKET" ] && MISSING_SECRETS+=("FIREBASE_STORAGE_BUCKET")
[ -z "$VITE_FIREBASE_MESSAGING_SENDER_ID" ] && MISSING_SECRETS+=("FIREBASE_MESSAGING_SENDER_ID")
[ -z "$VITE_FIREBASE_APP_ID" ] && MISSING_SECRETS+=("FIREBASE_APP_ID")

if [ ${#MISSING_SECRETS[@]} -gt 0 ]; then
    echo "⚠️  Warning: Some Firebase secrets are missing from Secret Manager:"
    for secret in "${MISSING_SECRETS[@]}"; do
        echo "     - ${secret}"
    done
    echo ""
    echo "Falling back to .env.local if available..."
    echo ""
    
    # Save VITE_API_BASE before sourcing .env.local to prevent localhost overwrite
    SAVED_API_BASE="$VITE_API_BASE"
    
    # Fall back to .env.local if it exists
    if [ -f ".env.local" ]; then
        echo "Loading from .env.local..."
        set -a
        source .env.local
        set +a
        
        # Restore VITE_API_BASE if it was already set (from Secret Manager or gcloud)
        # Never use localhost values from .env.local in production builds
        if [ -n "$SAVED_API_BASE" ]; then
            export VITE_API_BASE="$SAVED_API_BASE"
            echo "✅ Preserved VITE_API_BASE: $VITE_API_BASE (ignoring .env.local value)"
        elif [ -n "$VITE_API_BASE" ] && ([[ "$VITE_API_BASE" == *"localhost"* ]] || [[ "$VITE_API_BASE" == *"127.0.0.1"* ]]); then
            echo "⚠️  Warning: .env.local contains localhost VITE_API_BASE, clearing it"
            unset VITE_API_BASE
            echo "   This build will fail if CLOUD_RUN_SERVICE_URL is not set elsewhere"
        fi
    fi
fi

# Ensure we're in the frontend directory (should already be there, but be safe)
cd "$SCRIPT_DIR"

# Build the frontend
# Set CI mode and npm config to prevent interactive prompts
echo "Building frontend..."
export CI=true
export npm_config_progress=false
export npm_config_update_notifier=false
export npm_config_audit=false

# Always rebuild during deployment to ensure latest changes are included
# Remove old dist folder to ensure clean build
if [ -d "dist" ]; then
    echo "Removing old build artifacts..."
    rm -rf dist
fi

# For Firebase predeploy: run npm in a way that handles missing stdin
# Ensure stdin is available by redirecting from /dev/null before npm runs
echo "Building frontend..."
# Use a subshell with stdin redirected to prevent npm stdin errors
# This ensures npm always has a valid stdin stream, even in non-interactive contexts
(
    exec 0</dev/null
    CI=true npm run build
) 2>&1
BUILD_EXIT=$?
if [ $BUILD_EXIT -ne 0 ]; then
    exit $BUILD_EXIT
fi

echo ""
echo "✅ Build complete!"
