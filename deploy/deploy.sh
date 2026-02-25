#!/bin/bash

#########################################
# CHE Data Integrity Monitor Deployment Script
#
# This script handles deployment of both
# frontend and backend to production.
#########################################

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$( cd "$SCRIPT_DIR/.." && pwd )"

# Configuration
# HARDCODED: This script is specifically for the Data Integrity Monitor project
# This prevents accidental deployment to wrong projects (e.g., che-toolkit)
PROJECT_ID="data-integrity-monitor"

# Allow override via environment variable for testing, but warn if different
if [ -n "$GCP_PROJECT_ID" ] && [ "$GCP_PROJECT_ID" != "$PROJECT_ID" ]; then
    print_warning "GCP_PROJECT_ID environment variable is set to: ${GCP_PROJECT_ID}"
    print_warning "This script is hardcoded for: ${PROJECT_ID}"
    print_warning "Using hardcoded value to prevent project switching issues."
    echo ""
fi

# Safety check: Warn if project looks wrong (should never happen with hardcoded value)
if echo "$PROJECT_ID" | grep -qi "toolkit"; then
    print_error "ERROR: Project ID contains 'toolkit' - this is the wrong project!"
    echo "  Detected PROJECT_ID: ${PROJECT_ID}"
    echo "  Expected: data-integrity-monitor"
    echo ""
    print_error "This should never happen with the hardcoded value. Exiting for safety."
    exit 1
fi

REGION=${CLOUD_RUN_REGION:-us-central1}
SERVICE_NAME="integrity-runner"
ARTIFACT_REGISTRY=${ARTIFACT_REGISTRY:-integrity-monitor}

echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   CHE Data Integrity Monitor          ║${NC}"
echo -e "${BLUE}║   Deployment Script                   ║${NC}"
echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo ""

# Function to print colored status messages
print_status() {
    echo -e "${BLUE}▶${NC} $1"
}

print_success() {
    echo -e "${GREEN}✓${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

# Check if we're in the right directory
cd "$PROJECT_ROOT"
if [ ! -f "package.json" ] || [ ! -d "frontend" ] || [ ! -d "backend" ]; then
    print_error "Error: Must run this script from the project root directory"
    exit 1
fi

# Parse command line arguments
DEPLOY_FRONTEND=false
DEPLOY_BACKEND=false
DEPLOY_RULES=false
SKIP_TESTS=false

if [ $# -eq 0 ]; then
    # No arguments, deploy everything
    DEPLOY_FRONTEND=true
    DEPLOY_BACKEND=true
    DEPLOY_RULES=true
else
    # Parse arguments
    while [[ $# -gt 0 ]]; do
        case $1 in
            --frontend|-f)
                DEPLOY_FRONTEND=true
                shift
                ;;
            --backend|-b)
                DEPLOY_BACKEND=true
                shift
                ;;
            --rules|-r)
                DEPLOY_RULES=true
                shift
                ;;
            --skip-tests)
                SKIP_TESTS=true
                shift
                ;;
            --help|-h)
                echo "Usage: ./deploy/deploy.sh [OPTIONS]"
                echo ""
                echo "Deploy CHE Data Integrity Monitor to production"
                echo ""
                echo "Default behavior (no arguments):"
                echo "  - Deploys frontend, backend, and Firestore rules"
                echo ""
                echo "Options:"
                echo "  --frontend, -f     Deploy frontend only"
                echo "  --backend, -b      Deploy backend only"
                echo "  --rules, -r        Deploy Firestore rules only"
                echo "  --skip-tests       Skip TypeScript compilation check"
                echo "  --help, -h         Show this help message"
                echo ""
                echo "Examples:"
                echo "  ./deploy/deploy.sh                    # Deploy everything"
                echo "  ./deploy/deploy.sh --frontend         # Deploy frontend only"
                echo "  ./deploy/deploy.sh --backend          # Deploy backend only"
                echo "  ./deploy/deploy.sh -f -b              # Deploy frontend and backend"
                exit 0
                ;;
            *)
                print_error "Unknown option: $1"
                echo "Use --help for usage information"
                exit 1
                ;;
        esac
    done
fi

echo ""
print_status "Deployment plan:"
echo "  Frontend:      $([ "$DEPLOY_FRONTEND" = true ] && echo -e "${GREEN}YES${NC}" || echo -e "${YELLOW}NO${NC}")"
echo "  Backend:       $([ "$DEPLOY_BACKEND" = true ] && echo -e "${GREEN}YES${NC}" || echo -e "${YELLOW}NO${NC}")"
echo "  Rules:         $([ "$DEPLOY_RULES" = true ] && echo -e "${GREEN}YES${NC}" || echo -e "${YELLOW}NO${NC}")"
echo "  Project ID:    ${BLUE}${PROJECT_ID}${NC}"
echo "  Region:        ${BLUE}${REGION}${NC}"
echo ""

# If no deployment tasks selected, exit
if [ "$DEPLOY_FRONTEND" = false ] && [ "$DEPLOY_BACKEND" = false ] && [ "$DEPLOY_RULES" = false ]; then
    print_warning "No tasks selected. Use --help for usage information"
    exit 0
fi

echo ""
print_status "Starting tasks..."
echo ""

#########################################
# Deploy Firestore Rules
#########################################
if [ "$DEPLOY_RULES" = true ]; then
    print_status "Deploying Firestore rules..."

    if firebase deploy --only firestore:rules --project "$PROJECT_ID"; then
        print_success "Firestore rules deployed successfully"
    else
        print_error "Failed to deploy Firestore rules"
        exit 1
    fi

    echo ""
fi

#########################################
# Rules Management Note
#########################################
# Rules are now managed in Firestore only. The schema.yaml file has been removed.
# To create a snapshot/backup of Firestore rules, use:
#   python -m backend.scripts.migrate_rules --output schema.yaml.snapshot
# This is a read-only operation that does not modify Firestore.

#########################################
# Deploy Backend
#########################################
if [ "$DEPLOY_BACKEND" = true ]; then
    print_status "Deploying backend to Cloud Run..."

    # Check if gcloud is installed
    if ! command -v gcloud &> /dev/null; then
        print_error "gcloud CLI not found. Please install it first:"
        echo "  https://cloud.google.com/sdk/docs/install"
        exit 1
    fi

    # Check if backend files exist
    if [ ! -f "backend/main.py" ] || [ ! -f "backend/Dockerfile" ]; then
        print_error "Backend files not found"
        exit 1
    fi

    print_status "Building and deploying backend container..."

    # Check for required secrets
    # NOTE: This script ONLY VERIFIES secrets exist - it NEVER creates or updates them.
    # Secrets must be managed separately via create-secrets.sh or manually in Secret Manager.
    # This prevents accidental overwrites during deployment.
    # Note: SLACK_WEBHOOK_URL is optional - Slack notifications work without it
    print_status "Checking for required secrets in Secret Manager (verification only, no updates)..."
    REQUIRED_SECRETS=(
        "AIRTABLE_PAT"
        "API_AUTH_TOKEN"
        "OPENAI_API_KEY"
    )
    OPTIONAL_SECRETS=(
        "SLACK_WEBHOOK_URL"
    )
    
    # Test gcloud connectivity and authentication first
    # Note: We use --project flag explicitly to avoid gcloud config project issues
    print_status "Verifying gcloud access for project: ${PROJECT_ID}..."
    set +e  # Temporarily disable exit on error to capture output
    
    # Test gcloud with explicit project flag (don't rely on gcloud config)
    TEST_OUTPUT=$(gcloud projects describe "$PROJECT_ID" 2>&1)
    TEST_EXIT=$?
    
    # Check if there's an active account
    ACCOUNT_OUTPUT=$(gcloud config get-value account 2>&1)
    ACCOUNT_EXIT=$?
    if [ $ACCOUNT_EXIT -ne 0 ] || [ -z "$ACCOUNT_OUTPUT" ] || [ "$ACCOUNT_OUTPUT" = "(unset)" ]; then
        print_error "gcloud has no active account selected"
        echo ""
        print_warning "To fix this, run:"
        echo "  gcloud auth login"
        echo "  # Or for application default credentials:"
        echo "  gcloud auth application-default login"
        echo ""
        exit 1
    fi
    
    set -e  # Re-enable exit on error
    
    if [ $TEST_EXIT -ne 0 ]; then
        print_error "Cannot access project ${PROJECT_ID}. Error details:"
        echo "$TEST_OUTPUT" | head -20
        echo ""
        print_warning "Please verify:"
        echo "  1. You have access to project: ${PROJECT_ID}"
        echo "  2. gcloud is authenticated: gcloud auth login"
        echo "  3. Project exists and you have permissions"
        echo ""
        print_warning "Note: This script uses project ${PROJECT_ID} explicitly via --project flag"
        print_warning "      and does NOT rely on gcloud config to prevent project switching."
        exit 1
    fi
    
    MISSING_SECRETS=()
    GCLOUD_ERRORS=()
    
    # Check required secrets
    for secret in "${REQUIRED_SECRETS[@]}"; do
        echo -n "  Checking ${secret}... "
        set +e  # Temporarily disable exit on error
        ERROR_OUTPUT=$(gcloud secrets describe "$secret" --project="$PROJECT_ID" 2>&1)
        EXIT_CODE=$?
        set -e  # Re-enable exit on error
        
        if [ $EXIT_CODE -ne 0 ]; then
            # Check if it's a "not found" error first (most common)
            if echo "$ERROR_OUTPUT" | grep -qi "NOT_FOUND\|does not exist\|not found\|was not found"; then
                echo "NOT FOUND"
                MISSING_SECRETS+=("$secret")
            # Check if it's an authentication error (must NOT be NOT_FOUND)
            elif echo "$ERROR_OUTPUT" | grep -qi "not currently have an active\|Please run.*gcloud auth"; then
                echo "AUTH ERROR"
                ERROR_FIRST_LINE=$(echo "$ERROR_OUTPUT" | head -1)
                echo "    Error: $ERROR_FIRST_LINE"
                GCLOUD_ERRORS+=("$secret: Authentication required")
                MISSING_SECRETS+=("$secret")
            else
                echo "ERROR"
                ERROR_FIRST_LINE=$(echo "$ERROR_OUTPUT" | head -1)
                echo "    Error: $ERROR_FIRST_LINE"
                GCLOUD_ERRORS+=("$secret: $ERROR_FIRST_LINE")
                MISSING_SECRETS+=("$secret")
            fi
        else
            echo "OK"
        fi
    done
    
    # Check optional secrets (don't fail if missing)
    for secret in "${OPTIONAL_SECRETS[@]}"; do
        echo -n "  Checking ${secret} (optional)... "
        set +e  # Temporarily disable exit on error
        ERROR_OUTPUT=$(gcloud secrets describe "$secret" --project="$PROJECT_ID" 2>&1)
        EXIT_CODE=$?
        set -e  # Re-enable exit on error
        
        if [ $EXIT_CODE -ne 0 ]; then
            # Only report auth errors for optional secrets, not missing ones
            if echo "$ERROR_OUTPUT" | grep -qi "not currently have an active\|Please run.*gcloud auth"; then
                echo "AUTH ERROR"
                ERROR_FIRST_LINE=$(echo "$ERROR_OUTPUT" | head -1)
                echo "    Error: $ERROR_FIRST_LINE"
                GCLOUD_ERRORS+=("$secret: Authentication required")
            elif echo "$ERROR_OUTPUT" | grep -qi "NOT_FOUND\|does not exist\|not found\|was not found"; then
                echo "NOT FOUND (optional)"
            else
                echo "ERROR"
                ERROR_FIRST_LINE=$(echo "$ERROR_OUTPUT" | head -1)
                echo "    Error: $ERROR_FIRST_LINE"
                GCLOUD_ERRORS+=("$secret: $ERROR_FIRST_LINE")
            fi
        else
            echo "OK"
        fi
    done
    
    echo ""
    
    if [ ${#GCLOUD_ERRORS[@]} -gt 0 ]; then
        print_error "gcloud command failed while checking secrets:"
        for error in "${GCLOUD_ERRORS[@]}"; do
            echo "  $error"
        done
        echo ""
        
        # Check if it's an authentication issue
        if echo "${GCLOUD_ERRORS[@]}" | grep -qi "Authentication required\|active account"; then
            print_warning "gcloud authentication is required."
            print_warning ""
            print_warning "To fix, run one of these commands:"
            echo "  gcloud auth login"
            echo "  # Or for application default credentials:"
            echo "  gcloud auth application-default login"
            echo ""
            print_warning "If you're using gcloud configurations, activate one:"
            echo "  gcloud config configurations list"
            echo "  gcloud config configurations activate data-integrity-monitor"
            echo ""
        else
            print_warning "The secrets may exist, but gcloud cannot access them."
            print_warning "This usually indicates a gcloud configuration or permission issue."
            print_warning ""
            print_warning "To diagnose, run manually:"
            echo "  gcloud secrets describe OPENAI_API_KEY --project=${PROJECT_ID}"
            echo ""
        fi
        exit 1
    fi
    
    if [ ${#MISSING_SECRETS[@]} -gt 0 ]; then
        print_error "Missing secrets in Secret Manager:"
        for secret in "${MISSING_SECRETS[@]}"; do
            echo "  - ${secret}"
        done
        echo ""
        print_warning "If the secret exists in the UI, verify:"
        echo "  1. Secret name matches exactly (case-sensitive)"
        echo "  2. Secret is in project: ${PROJECT_ID}"
        echo "  3. List all secrets: gcloud secrets list --project=${PROJECT_ID}"
        echo ""
        print_warning "NOTE: This script does NOT create or update secrets."
        print_warning "      Create the missing secrets using:"
        echo "  ./deploy/create-secrets.sh"
        echo ""
        print_warning "Or create them manually in Secret Manager:"
        echo "  gcloud secrets create SECRET_NAME --data-file=- --project=${PROJECT_ID}"
        echo ""
        exit 1
    else
        print_success "All required secrets found"
    fi

    # Check if custom service account exists
    CUSTOM_SERVICE_ACCOUNT="integrity-runner@${PROJECT_ID}.iam.gserviceaccount.com"
    DEFAULT_SERVICE_ACCOUNT="${PROJECT_ID}-compute@developer.gserviceaccount.com"
    SERVICE_ACCOUNT="$DEFAULT_SERVICE_ACCOUNT"
    
    if gcloud iam service-accounts describe "$CUSTOM_SERVICE_ACCOUNT" --project "$PROJECT_ID" &>/dev/null; then
        SERVICE_ACCOUNT="$CUSTOM_SERVICE_ACCOUNT"
        print_status "Using custom service account: ${SERVICE_ACCOUNT}"
    else
        print_status "Using default compute service account: ${SERVICE_ACCOUNT}"
        print_status "Ensuring Secret Manager permissions are granted..."
        
        # Grant Secret Manager Secret Accessor role to default compute service account
        if gcloud projects add-iam-policy-binding "$PROJECT_ID" \
            --member="serviceAccount:${SERVICE_ACCOUNT}" \
            --role="roles/secretmanager.secretAccessor" \
            --condition=None \
            &>/dev/null; then
            print_success "Granted Secret Manager access to default service account"
        else
            # Try with explicit project flag
            if gcloud projects add-iam-policy-binding "$PROJECT_ID" \
                --member="serviceAccount:${SERVICE_ACCOUNT}" \
                --role="roles/secretmanager.secretAccessor" \
                --project="$PROJECT_ID" \
                &>/dev/null; then
                print_success "Granted Secret Manager access to default service account"
            else
                print_warning "Could not automatically grant Secret Manager access."
                print_warning "Please run this command manually:"
                echo ""
                echo "  gcloud projects add-iam-policy-binding ${PROJECT_ID} \\"
                echo "    --member=\"serviceAccount:${SERVICE_ACCOUNT}\" \\"
                echo "    --role=\"roles/secretmanager.secretAccessor\""
                echo ""
                print_warning "Or run: ./deploy/iam-setup.sh to set up a custom service account with permissions"
                echo ""
            fi
        fi
    fi

    # Check if optional SLACK_WEBHOOK_URL exists
    SLACK_WEBHOOK_EXISTS=false
    if gcloud secrets describe "SLACK_WEBHOOK_URL" --project="$PROJECT_ID" &>/dev/null; then
        SLACK_WEBHOOK_EXISTS=true
    fi

    # Create temporary env-vars file to handle commas in ALLOWED_ORIGINS value
    # Note: gcloud requires YAML or JSON format, not plain KEY=VALUE
    # Changed default to '*' to match redeploy-backend.sh and ensure maximum compatibility
    ALLOWED_ORIGINS_VALUE="${ALLOWED_ORIGINS:-*}"
    ENV_VARS_FILE=$(mktemp)
    cat > "$ENV_VARS_FILE" <<EOF
ALLOWED_ORIGINS: "${ALLOWED_ORIGINS_VALUE}"
AIRTABLE_MIN_REQUEST_INTERVAL: "0.05"
EOF

    # ------------------------------------------------------------------
    # Build backend image with NO CACHE (prevents Cloud Build layer reuse)
    # This is critical when you need to guarantee Cloud Run is running the
    # exact backend code currently in the repo.
    # ------------------------------------------------------------------
    print_status "Ensuring Artifact Registry repository exists (${ARTIFACT_REGISTRY} in ${REGION})..."
    set +e
    gcloud artifacts repositories describe "${ARTIFACT_REGISTRY}" \
      --location "${REGION}" \
      --project "${PROJECT_ID}" \
      >/dev/null 2>&1
    AR_EXISTS=$?
    set -e

    if [ $AR_EXISTS -ne 0 ]; then
        print_warning "Artifact Registry repo '${ARTIFACT_REGISTRY}' not found. Creating it..."
        # Ensure Artifact Registry API is enabled (safe to call repeatedly)
        if ! gcloud services enable artifactregistry.googleapis.com --project "${PROJECT_ID}" >/dev/null 2>&1; then
            print_error "Failed to enable Artifact Registry API"
            rm -f "$ENV_VARS_FILE"
            exit 1
        fi

        if ! gcloud artifacts repositories create "${ARTIFACT_REGISTRY}" \
          --repository-format=docker \
          --location "${REGION}" \
          --description "Docker repo for ${SERVICE_NAME}" \
          --project "${PROJECT_ID}" >/dev/null 2>&1; then
            print_error "Failed to create Artifact Registry repo '${ARTIFACT_REGISTRY}' in ${REGION}"
            print_warning "You may need permissions: Artifact Registry Admin (roles/artifactregistry.admin)"
            rm -f "$ENV_VARS_FILE"
            exit 1
        fi
        print_success "Created Artifact Registry repo: ${ARTIFACT_REGISTRY}"
    else
        print_success "Artifact Registry repo exists: ${ARTIFACT_REGISTRY}"
    fi

    print_status "Building backend image (no-cache) via Cloud Build..."
    SHORT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "manual-$(date +%s)")
    IMAGE_URI="${REGION}-docker.pkg.dev/${PROJECT_ID}/${ARTIFACT_REGISTRY}/${SERVICE_NAME}:${SHORT_SHA}"

    set +e
    gcloud builds submit . \
      --config deploy/cloudbuild-backend-build.yaml \
      --project "${PROJECT_ID}" \
      --substitutions=_REGION="${REGION}",_ARTIFACT_REGISTRY="${ARTIFACT_REGISTRY}",_SERVICE_NAME="${SERVICE_NAME}",SHORT_SHA="${SHORT_SHA}"
    BUILD_STATUS=$?
    set -e

    if [ $BUILD_STATUS -ne 0 ]; then
        print_error "Backend image build failed"
        rm -f "$ENV_VARS_FILE"
        exit 1
    fi
    print_success "Backend image built: ${IMAGE_URI}"

    # Build base deploy command (deploy the freshly-built image)
    DEPLOY_CMD=(
        "gcloud" "run" "deploy" "$SERVICE_NAME"
        "--image" "$IMAGE_URI"
        "--region" "$REGION"
        "--platform" "managed"
        "--allow-unauthenticated"
        "--memory" "2Gi"
        "--cpu" "2"
        "--no-cpu-throttling"
        "--timeout" "30m"
        "--min-instances" "0"
        "--max-instances" "10"
        "--concurrency" "5"
        "--env-vars-file" "$ENV_VARS_FILE"
        "--set-secrets" "AIRTABLE_PAT=AIRTABLE_PAT:latest"
        "--set-secrets" "API_AUTH_TOKEN=API_AUTH_TOKEN:latest"
        "--set-secrets" "OPENAI_API_KEY=OPENAI_API_KEY:latest"
        "--project" "$PROJECT_ID"
    )

    # Add SLACK_WEBHOOK_URL only if it exists
    if [ "$SLACK_WEBHOOK_EXISTS" = true ]; then
        DEPLOY_CMD+=("--set-secrets" "SLACK_WEBHOOK_URL=SLACK_WEBHOOK_URL:latest")
    fi

    # Add service account only if it's the custom one
    if [ "$SERVICE_ACCOUNT" != "${PROJECT_ID}-compute@developer.gserviceaccount.com" ]; then
        DEPLOY_CMD+=("--service-account" "$SERVICE_ACCOUNT")
    fi

    # Try deployment
    set +e
    "${DEPLOY_CMD[@]}"
    DEPLOY_STATUS=$?
    set -e

    # If deployment failed with custom service account, retry without it
    if [ $DEPLOY_STATUS -ne 0 ] && [ "$SERVICE_ACCOUNT" != "${PROJECT_ID}-compute@developer.gserviceaccount.com" ]; then
        print_warning "Deployment with custom service account failed, retrying without explicit service account..."
        # Remove service account from args, reuse env-vars-file
        DEPLOY_CMD=(
            "gcloud" "run" "deploy" "$SERVICE_NAME"
            "--image" "$IMAGE_URI"
            "--region" "$REGION"
            "--platform" "managed"
            "--allow-unauthenticated"
            "--memory" "2Gi"
            "--cpu" "2"
            "--no-cpu-throttling"
            "--timeout" "30m"
            "--min-instances" "1"
            "--max-instances" "10"
            "--concurrency" "5"
            "--env-vars-file" "$ENV_VARS_FILE"
            "--set-secrets" "AIRTABLE_PAT=AIRTABLE_PAT:latest"
            "--set-secrets" "API_AUTH_TOKEN=API_AUTH_TOKEN:latest"
            "--set-secrets" "OPENAI_API_KEY=OPENAI_API_KEY:latest"
            "--project" "$PROJECT_ID"
        )

        # Add SLACK_WEBHOOK_URL only if it exists
        if [ "$SLACK_WEBHOOK_EXISTS" = true ]; then
            DEPLOY_CMD+=("--set-secrets" "SLACK_WEBHOOK_URL=SLACK_WEBHOOK_URL:latest")
        fi
        "${DEPLOY_CMD[@]}"
        DEPLOY_STATUS=$?
    fi
    
    # Clean up temporary env-vars file
    rm -f "$ENV_VARS_FILE"

    if [ $DEPLOY_STATUS -eq 0 ]; then
        print_success "Backend deployed successfully"

        # Get the service URL
        SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" \
            --region "$REGION" \
            --project "$PROJECT_ID" \
            --format="value(status.url)")

        echo ""
        print_success "Backend URL: $SERVICE_URL"

        # Check if frontend .env needs updating
        if [ -f "frontend/.env" ]; then
            CURRENT_API_BASE=$(grep "VITE_API_BASE=" frontend/.env | cut -d'=' -f2)
            if [ "$CURRENT_API_BASE" != "$SERVICE_URL" ]; then
                print_warning "Note: Update VITE_API_BASE in frontend/.env to: $SERVICE_URL"
                print_warning "Then rebuild and redeploy frontend"
            fi
        fi
    else
        print_error "Failed to deploy backend"
        exit 1
    fi

    echo ""
fi

#########################################
# Deploy Frontend
#########################################
if [ "$DEPLOY_FRONTEND" = true ]; then
    print_status "Deploying frontend to Firebase Hosting..."

    # Check if frontend directory exists
    if [ ! -d "frontend" ]; then
        print_error "Frontend directory not found"
        exit 1
    fi

    # Check if node_modules exists
    if [ ! -d "frontend/node_modules" ]; then
        print_warning "node_modules not found. Running npm install..."
        cd frontend
        npm install
        cd ..
    fi

    # Build frontend using build-with-secrets.sh which sets VITE_API_BASE to Cloud Run URL
    print_status "Building frontend with Cloud Run API URL..."
    cd frontend
    if [ ! -f "build-with-secrets.sh" ]; then
        print_error "frontend/build-with-secrets.sh not found"
        exit 1
    fi
    # Pass the correct project ID and region to the build script
    GCP_PROJECT_ID="$PROJECT_ID" CLOUD_RUN_REGION="$REGION" ./build-with-secrets.sh
    BUILD_EXIT=$?
    cd ..
    
    if [ $BUILD_EXIT -ne 0 ]; then
        print_error "Frontend build failed"
        exit 1
    fi
    
    print_success "Frontend built successfully"

    print_status "Deploying to Firebase Hosting..."

    if firebase deploy --only hosting --project "$PROJECT_ID"; then
        print_success "Frontend deployed successfully"
        FRONTEND_URL=$(firebase hosting:sites:list --project "$PROJECT_ID" --json 2>/dev/null | grep -o '"defaultHosting":\s*"[^"]*"' | cut -d'"' -f4 || echo "data-integrity-monitor.web.app")
        if [ -n "$FRONTEND_URL" ]; then
            print_success "Frontend URL: https://${FRONTEND_URL}"
        fi
    else
        print_error "Failed to deploy frontend"
        exit 1
    fi

    echo ""
fi

#########################################
# Tasks Complete
#########################################
echo ""
echo -e "${GREEN}╔════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   Tasks Complete!                      ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════╝${NC}"
echo ""

print_success "All tasks completed successfully"

# Show relevant information based on what was done
if [ "$DEPLOY_FRONTEND" = true ] || [ "$DEPLOY_BACKEND" = true ]; then
    echo ""
    echo "Production URLs:"
    if [ "$DEPLOY_FRONTEND" = true ]; then
        FRONTEND_URL=$(firebase hosting:sites:list --project "$PROJECT_ID" --json 2>/dev/null | grep -o '"defaultHosting":\s*"[^"]*"' | cut -d'"' -f4 || echo "data-integrity-monitor.web.app")
        echo "  Frontend: ${BLUE}https://${FRONTEND_URL}${NC}"
    fi
    if [ "$DEPLOY_BACKEND" = true ]; then
        SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" \
            --region "$REGION" \
            --project "$PROJECT_ID" \
            --format="value(status.url)" 2>/dev/null || echo "")
        if [ -n "$SERVICE_URL" ]; then
            echo "  Backend:  ${BLUE}$SERVICE_URL${NC}"
        fi
    fi
    
    echo ""
    echo "Next steps:"
    echo "  1. Test the deployed application"
    if [ "$DEPLOY_BACKEND" = true ]; then
        echo "  2. Check logs: ${BLUE}gcloud run logs read --service=$SERVICE_NAME --region=$REGION --project=$PROJECT_ID${NC}"
        echo "  3. Monitor: ${BLUE}https://console.cloud.google.com/run?project=$PROJECT_ID${NC}"
    fi
fi

echo ""
print_success "Script finished"
