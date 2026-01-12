#!/bin/bash

# Script to get Firebase ID token for API testing
# Usage: ./scripts/get-firebase-token.sh

set -e

BACKEND_URL="${BACKEND_URL:-http://localhost:8000}"
EMAIL="${EMAIL:-jedwards@che.school}"

echo "Getting custom token from backend..."
CUSTOM_TOKEN_RESPONSE=$(curl -s "${BACKEND_URL}/auth/dev-token?email=${EMAIL}")

# Check if we got an error
if echo "$CUSTOM_TOKEN_RESPONSE" | grep -q "error\|Error\|detail"; then
    echo "Error getting custom token:"
    echo "$CUSTOM_TOKEN_RESPONSE"
    exit 1
fi

# Extract token from JSON response (works with both jq and without)
if command -v jq &> /dev/null; then
    CUSTOM_TOKEN=$(echo "$CUSTOM_TOKEN_RESPONSE" | jq -r '.token')
else
    # Fallback: extract token manually (basic JSON parsing)
    CUSTOM_TOKEN=$(echo "$CUSTOM_TOKEN_RESPONSE" | grep -o '"token"[[:space:]]*:[[:space:]]*"[^"]*"' | cut -d'"' -f4)
fi

if [ -z "$CUSTOM_TOKEN" ] || [ "$CUSTOM_TOKEN" = "null" ]; then
    echo "Failed to extract custom token from response:"
    echo "$CUSTOM_TOKEN_RESPONSE"
    exit 1
fi

echo ""
echo "Custom token received. Now exchanging for ID token..."
echo ""

# Use Node.js to exchange custom token for ID token
NODE_SCRIPT=$(cat <<'EOF'
const { initializeApp } = require('firebase/app');
const { getAuth, signInWithCustomToken } = require('firebase/auth');

const customToken = process.argv[2];
const firebaseConfig = {
  apiKey: process.env.VITE_FIREBASE_API_KEY,
  authDomain: process.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: process.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.VITE_FIREBASE_APP_ID,
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

signInWithCustomToken(auth, customToken)
  .then((userCredential) => {
    return userCredential.user.getIdToken();
  })
  .then((idToken) => {
    console.log(idToken);
  })
  .catch((error) => {
    console.error('Error:', error.message);
    process.exit(1);
  });
EOF
)

# Check if we're in the frontend directory or root
if [ -f "frontend/.env" ]; then
    ENV_FILE="frontend/.env"
elif [ -f ".env" ]; then
    ENV_FILE=".env"
else
    echo "Error: Could not find .env file with Firebase config"
    exit 1
fi

# Load environment variables from .env file
export $(grep -v '^#' "$ENV_FILE" | grep VITE_FIREBASE | xargs)

# Run Node.js script
ID_TOKEN=$(echo "$NODE_SCRIPT" | node - "$CUSTOM_TOKEN")

if [ -z "$ID_TOKEN" ] || [[ "$ID_TOKEN" == Error* ]]; then
    echo "Failed to get ID token:"
    echo "$ID_TOKEN"
    echo ""
    echo "Make sure:"
    echo "1. Backend is running on $BACKEND_URL"
    echo "2. Firebase config is in $ENV_FILE"
    echo "3. Node.js and firebase npm package are installed"
    exit 1
fi

echo ""
echo "=========================================="
echo "Your Firebase ID Token:"
echo "=========================================="
echo "$ID_TOKEN"
echo ""
echo "=========================================="
echo "Use it in curl like this:"
echo "=========================================="
echo "curl -H \"Authorization: Bearer $ID_TOKEN\" \\"
echo "  ${BACKEND_URL}/admin/school-years/current"
echo ""
echo "=========================================="
echo "Or save to variable:"
echo "=========================================="
echo "export TOKEN=\"$ID_TOKEN\""
echo "curl -H \"Authorization: Bearer \$TOKEN\" \\"
echo "  ${BACKEND_URL}/admin/school-years/current"
echo ""

