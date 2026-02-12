# OpenAI API Key Security Migration

## ✅ Completed

1. **Created secure secrets utility** (`backend/utils/secrets.py`)

   - Fetches secrets from Google Secret Manager for local development
   - Falls back to environment variables (for Cloud Run production)
   - Gracefully handles missing secrets

2. **Updated deployment scripts**

   - `deploy/create-secrets.sh` - Now includes OPENAI_API_KEY
   - `deploy/configure-cloud-run-secrets.sh` - Now configures OPENAI_API_KEY for Cloud Run

3. **Updated code to use secure method**

   - `backend/services/ai_rule_parser.py` - Now uses `get_secret()` instead of `os.getenv()`

4. **Removed secret from .env file**
   - OPENAI_API_KEY has been removed from `backend/.env`
   - File is already in `.gitignore` ✅

## 🔄 Next Steps

### 1. Add Secret to Google Secret Manager

Run the helper script:

```bash
./scripts/add-openai-secret.sh
```

Or manually:

```bash
# Get your OpenAI API key (you'll need to retrieve it from OpenAI dashboard)
# Then create the secret:
echo -n "YOUR_OPENAI_API_KEY" | gcloud secrets create OPENAI_API_KEY \
  --data-file=- \
  --replication-policy="automatic" \
  --project=data-integrity-monitor
```

### 2. Update Cloud Run Service

After adding the secret to Secret Manager:

```bash
cd deploy
./configure-cloud-run-secrets.sh
```

This will inject OPENAI_API_KEY as an environment variable in Cloud Run.

### 3. Remove Secret from Git History

**⚠️ IMPORTANT:** The secret is still in git history. You need to remove it before pushing.

**Option A: Using git-filter-repo (Recommended)**

```bash
# Install git-filter-repo if not already installed
pip install git-filter-repo
# OR
brew install git-filter-repo

# Run the cleanup script
./scripts/remove-secret-from-history.sh
```

**Option B: Using BFG Repo-Cleaner**

```bash
# Download BFG from https://rtyley.github.io/bfg-repo-cleaner/
# Create a file with the secret value
echo "YOUR_SECRET_VALUE_HERE" > secrets.txt

# Run BFG
java -jar bfg.jar --replace-text secrets.txt

# Clean up
git reflog expire --expire=now --all
git gc --prune=now --aggressive
```

**Option C: Manual Git History Cleanup**

```bash
# Commit current changes first
git add backend/.env
git commit -m "Remove OPENAI_API_KEY from .env file"

# Then use git filter-branch (after committing)
FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch --force --index-filter \
  'git rm --cached --ignore-unmatch backend/.env' \
  --prune-empty --tag-name-filter cat -- --all

# Force push (coordinate with team first!)
git push origin --force --all
git push origin --force --tags
```

### 4. Verify Secret is Working

**Local Development:**

```bash
# The secret will be automatically fetched from Secret Manager
# when the backend starts (if not in environment variables)
cd backend
python -m uvicorn main:app --reload
```

**Production (Cloud Run):**

- Secret is injected as environment variable automatically
- No code changes needed

## 🔒 Security Notes

1. **Never commit .env files** - Already in `.gitignore` ✅
2. **Rotate the exposed key** - The key that was in git history should be rotated in OpenAI dashboard
3. **Use Secret Manager for all secrets** - Follow the same pattern for other secrets
4. **Local development** - Secrets are fetched from Secret Manager automatically if not in environment

## Files Modified

- ✅ `backend/utils/secrets.py` - New secure secrets utility
- ✅ `backend/services/ai_rule_parser.py` - Uses secure method
- ✅ `deploy/create-secrets.sh` - Includes OPENAI_API_KEY
- ✅ `deploy/configure-cloud-run-secrets.sh` - Configures OPENAI_API_KEY
- ✅ `backend/.env` - OPENAI_API_KEY removed
- ✅ `scripts/add-openai-secret.sh` - Helper script to add secret
- ✅ `scripts/remove-secret-from-history.sh` - Helper script for git cleanup
