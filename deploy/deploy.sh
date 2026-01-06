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
# Priority: 1) GCP_PROJECT_ID env var, 2) .firebaserc, 3) gcloud config
if [ -n "$GCP_PROJECT_ID" ]; then
    PROJECT_ID="$GCP_PROJECT_ID"
elif [ -f "$PROJECT_ROOT/.firebaserc" ]; then
    PROJECT_ID=$(grep -o '"default":\s*"[^"]*"' "$PROJECT_ROOT/.firebaserc" | cut -d'"' -f4)
fi

# Fallback to gcloud config if still not set
if [ -z "$PROJECT_ID" ]; then
    PROJECT_ID=$(gcloud config get-value project 2>/dev/null || echo "")
fi

if [ -z "$PROJECT_ID" ]; then
    echo -e "${RED}Error: PROJECT_ID not found${NC}"
    echo "Set GCP_PROJECT_ID environment variable or configure gcloud:"
    echo "  export GCP_PROJECT_ID=your-project-id"
    echo "  gcloud config set project your-project-id"
    exit 1
fi

REGION=${CLOUD_RUN_REGION:-us-central1}
SERVICE_NAME="integrity-runner"

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
    print_status "Checking for required secrets in Secret Manager..."
    REQUIRED_SECRETS=(
        "AIRTABLE_PAT"
        "API_AUTH_TOKEN"
        "OPENAI_API_KEY"
    )
    
    # Test gcloud connectivity first with a quick command
    print_status "Verifying gcloud access..."
    set +e  # Temporarily disable exit on error to capture output
    TEST_OUTPUT=$(gcloud config get-value project 2>&1)
    TEST_EXIT=$?
    set -e  # Re-enable exit on error
    
    if [ $TEST_EXIT -ne 0 ]; then
        print_error "gcloud is not working properly. Error details:"
        echo "$TEST_OUTPUT" | head -20
        echo ""
        print_warning "Please fix gcloud installation before continuing."
        print_warning "Common fixes:"
        echo "  - Reinstall gcloud: https://cloud.google.com/sdk/docs/install"
        echo "  - Check Python: gcloud may need Python 3.9-3.14"
        echo "  - Try: gcloud components reinstall"
        exit 1
    fi
    
    MISSING_SECRETS=()
    GCLOUD_ERRORS=()
    for secret in "${REQUIRED_SECRETS[@]}"; do
        echo -n "  Checking ${secret}... "
        set +e  # Temporarily disable exit on error
        ERROR_OUTPUT=$(gcloud secrets describe "$secret" --project="$PROJECT_ID" 2>&1)
        EXIT_CODE=$?
        set -e  # Re-enable exit on error
        
        if [ $EXIT_CODE -ne 0 ]; then
            # Check if it's a "not found" error or a gcloud failure
            if echo "$ERROR_OUTPUT" | grep -qi "NOT_FOUND\|does not exist\|not found\|was not found"; then
                echo "NOT FOUND"
                # Show the actual error for debugging
                echo "    Error: $(echo "$ERROR_OUTPUT" | head -1)"
                MISSING_SECRETS+=("$secret")
            else
                echo "ERROR"
                # Show first line of error for diagnosis
                ERROR_FIRST_LINE=$(echo "$ERROR_OUTPUT" | head -1)
                echo "    Error: $ERROR_FIRST_LINE"
                GCLOUD_ERRORS+=("$secret: $ERROR_FIRST_LINE")
                MISSING_SECRETS+=("$secret")
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
        print_warning "The secrets may exist, but gcloud cannot access them."
        print_warning "This usually indicates a gcloud configuration or permission issue."
        print_warning ""
        print_warning "To diagnose, run manually:"
        echo "  gcloud secrets describe OPENAI_API_KEY --project=${PROJECT_ID}"
        echo ""
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
        print_warning "Create the missing secrets using:"
        echo "  ./deploy/create-secrets.sh"
        echo ""
        print_warning "Or create them manually:"
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

    # Build base deploy command
    DEPLOY_CMD=(
        "gcloud" "run" "deploy" "$SERVICE_NAME"
        "--source" "backend"
        "--region" "$REGION"
        "--platform" "managed"
        "--allow-unauthenticated"
        "--memory" "4Gi"
        "--cpu" "2"
        "--timeout" "30m"
        "--min-instances" "0"
        "--max-instances" "10"
        "--concurrency" "80"
        "--set-env-vars" "ALLOWED_ORIGINS=${ALLOWED_ORIGINS:-*},AIRTABLE_MIN_REQUEST_INTERVAL=0.05"
        "--set-secrets" "AIRTABLE_PAT=AIRTABLE_PAT:latest"
        "--set-secrets" "API_AUTH_TOKEN=API_AUTH_TOKEN:latest"
        "--set-secrets" "OPENAI_API_KEY=OPENAI_API_KEY:latest"
        "--project" "$PROJECT_ID"
    )

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
        # Remove service account from args
        DEPLOY_CMD=(
            "gcloud" "run" "deploy" "$SERVICE_NAME"
            "--source" "backend"
            "--region" "$REGION"
            "--platform" "managed"
            "--allow-unauthenticated"
            "--memory" "4Gi"
            "--cpu" "2"
            "--timeout" "30m"
            "--min-instances" "0"
            "--max-instances" "10"
            "--concurrency" "80"
            "--set-env-vars" "ALLOWED_ORIGINS=${ALLOWED_ORIGINS:-*},AIRTABLE_MIN_REQUEST_INTERVAL=0.05"
            "--set-secrets" "AIRTABLE_PAT=AIRTABLE_PAT:latest"
            "--set-secrets" "API_AUTH_TOKEN=API_AUTH_TOKEN:latest"
            "--set-secrets" "OPENAI_API_KEY=OPENAI_API_KEY:latest"
            "--project" "$PROJECT_ID"
        )
        "${DEPLOY_CMD[@]}"
        DEPLOY_STATUS=$?
    fi

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
    ./build-with-secrets.sh
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
