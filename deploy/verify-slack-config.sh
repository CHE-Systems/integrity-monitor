#!/bin/bash

#########################################
# Verify Slack Webhook Configuration
#
# Checks if SLACK_WEBHOOK_URL is properly
# configured in Cloud Run service
#########################################

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

PROJECT_ID="data-integrity-monitor"
REGION=${CLOUD_RUN_REGION:-us-central1}
SERVICE_NAME="integrity-runner"

echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   Slack Webhook Configuration Check  ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════╝${NC}"
echo ""

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

#########################################
# Check Secret Manager
#########################################
print_status "Checking Secret Manager for SLACK_WEBHOOK_URL..."
echo ""

# Check if secret exists
if gcloud secrets describe "SLACK_WEBHOOK_URL" --project="$PROJECT_ID" &>/dev/null; then
    print_success "Secret 'SLACK_WEBHOOK_URL' exists in Secret Manager"
    
    # Get secret metadata (can't read value without proper permissions)
    SECRET_INFO=$(gcloud secrets describe "SLACK_WEBHOOK_URL" --project="$PROJECT_ID" --format="json" 2>/dev/null)
    if [ -n "$SECRET_INFO" ]; then
        echo "  Secret details:"
        echo "$SECRET_INFO" | grep -E '"name"|"createTime"|"replication"' | sed 's/^/    /'
    fi
else
    print_error "Secret 'SLACK_WEBHOOK_URL' NOT FOUND in Secret Manager"
    echo ""
    print_warning "The secret must exist for Slack notifications to work."
    echo "  Create it with: ./deploy/create-secrets.sh"
    echo ""
fi

echo ""

# Also check for lowercase version (backend fallback)
print_status "Checking for alternative secret name 'slack-webhook-url' (backend fallback)..."
if gcloud secrets describe "slack-webhook-url" --project="$PROJECT_ID" &>/dev/null; then
    print_success "Secret 'slack-webhook-url' exists (backend fallback)"
else
    print_warning "Secret 'slack-webhook-url' not found (this is OK if SLACK_WEBHOOK_URL exists)"
fi

echo ""

#########################################
# Check Cloud Run Service Configuration
#########################################
print_status "Checking Cloud Run service configuration..."
echo ""

# Get service configuration
SERVICE_CONFIG=$(gcloud run services describe "$SERVICE_NAME" \
    --region "$REGION" \
    --project "$PROJECT_ID" \
    --format="json" 2>/dev/null)

if [ -z "$SERVICE_CONFIG" ]; then
    print_error "Could not retrieve Cloud Run service configuration"
    exit 1
fi

# Check if SLACK_WEBHOOK_URL is in environment variables
if echo "$SERVICE_CONFIG" | grep -q "SLACK_WEBHOOK_URL"; then
    print_success "SLACK_WEBHOOK_URL is configured in Cloud Run service"
    
    # Extract the secret reference
    SLACK_CONFIG=$(echo "$SERVICE_CONFIG" | grep -A 5 "SLACK_WEBHOOK_URL" | head -10)
    echo "  Configuration:"
    echo "$SLACK_CONFIG" | sed 's/^/    /'
else
    print_error "SLACK_WEBHOOK_URL is NOT configured in Cloud Run service"
    echo ""
    print_warning "This means Slack notifications will not work."
    print_warning "The service needs to be redeployed with the secret."
    echo ""
    print_warning "To fix, run: ./deploy/deploy.sh --backend"
fi

echo ""

#########################################
# Check Recent Logs for Slack Debug Messages
#########################################
print_status "Checking recent logs for Slack webhook debug messages..."
echo ""

# Get last 50 log entries
RECENT_LOGS=$(gcloud logging read \
    "resource.type=cloud_run_revision AND resource.labels.service_name=$SERVICE_NAME" \
    --project="$PROJECT_ID" \
    --limit=50 \
    --format="json" 2>/dev/null | grep -i "slack\|webhook" || true)

if [ -n "$RECENT_LOGS" ]; then
    print_success "Found Slack-related log entries"
    echo ""
    echo "Recent Slack debug messages:"
    echo "$RECENT_LOGS" | head -20 | sed 's/^/    /'
else
    print_warning "No recent Slack-related log entries found"
    echo "  This could mean:"
    echo "    1. No scans have run recently"
    echo "    2. Slack webhook is not being checked"
    echo "    3. Logs are not being captured"
fi

echo ""

#########################################
# Summary
#########################################
echo ""
echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   Summary                             ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════╝${NC}"
echo ""

# Final check
SECRET_EXISTS=false
SERVICE_HAS_SECRET=false

if gcloud secrets describe "SLACK_WEBHOOK_URL" --project="$PROJECT_ID" &>/dev/null; then
    SECRET_EXISTS=true
fi

if echo "$SERVICE_CONFIG" | grep -q "SLACK_WEBHOOK_URL"; then
    SERVICE_HAS_SECRET=true
fi

if [ "$SECRET_EXISTS" = true ] && [ "$SERVICE_HAS_SECRET" = true ]; then
    print_success "Slack webhook appears to be properly configured"
    echo ""
    echo "If Slack messages are still not working, check:"
    echo "  1. The webhook URL is valid and active"
    echo "  2. The scan is actually finding issues (warnings/errors)"
    echo "  3. The 'Send to Slack' option is enabled in the scan configuration"
    echo "  4. Check Cloud Run logs for detailed error messages:"
    echo "     ${BLUE}gcloud run logs read --service=$SERVICE_NAME --region=$REGION --project=$PROJECT_ID${NC}"
elif [ "$SECRET_EXISTS" = true ] && [ "$SERVICE_HAS_SECRET" = false ]; then
    print_error "Secret exists but service is not configured to use it"
    echo ""
    print_warning "Redeploy the backend to fix this:"
    echo "  ${BLUE}./deploy/deploy.sh --backend${NC}"
elif [ "$SECRET_EXISTS" = false ]; then
    print_error "Secret does not exist in Secret Manager"
    echo ""
    print_warning "Create the secret first:"
    echo "  ${BLUE}./deploy/create-secrets.sh${NC}"
    echo "  Or manually:"
    echo "    ${BLUE}gcloud secrets create SLACK_WEBHOOK_URL --data-file=- --project=$PROJECT_ID${NC}"
fi

echo ""

