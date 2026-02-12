# Remove backend/.env from Git History

The `backend/.env` file contains secrets and needs to be removed from git history.

## Quick Fix (Recommended)

**Option 1: Use git-filter-repo (Best)**

```bash
# Install if needed
pip install git-filter-repo
# OR
brew install git-filter-repo

# Remove from history
git filter-repo --path backend/.env --invert-paths --force

# Force push
git push origin --force --all
git push origin --force --tags
```

**Option 2: Use git filter-branch**

```bash
FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch --force --index-filter \
  'git rm --cached --ignore-unmatch backend/.env' \
  --prune-empty --tag-name-filter cat -- --all

# Clean up
git reflog expire --expire=now --all
git gc --prune=now --aggressive

# Force push
git push origin --force --all
git push origin --force --tags
```

**Option 3: Use the script**

```bash
./scripts/remove-env-from-history-simple.sh
```

## What Was Done

1. ✅ Removed `backend/.env` from git tracking (file still exists locally)
2. ✅ Committed the removal
3. ⏳ Need to remove from history (run one of the options above)

## Important Notes

- **The local file is preserved** - it's just removed from git
- **This rewrites git history** - you'll need to force push
- **Coordinate with your team** - anyone who has cloned the repo will need to re-clone or reset
- **The file is already in `.gitignore`** - it won't be tracked again

## After Removing from History

1. Force push to GitHub:

   ```bash
   git push origin --force --all
   git push origin --force --tags
   ```

2. Verify the secret is gone:

   ```bash
   git log --all --full-history -- backend/.env
   # Should return nothing
   ```

3. GitHub push protection should now allow the push
