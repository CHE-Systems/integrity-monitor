# How to Start the Servers

## Quick Start

### Terminal 1 - Backend

```bash
cd "/Users/joshuaedwards/Library/CloudStorage/GoogleDrive-jedwards@che.school/My Drive/CHE/che-data-integrity-monitor"
source backend/.venv/bin/activate
uvicorn backend.main:app --reload --reload-exclude "**/.venv/**" --reload-exclude "**/__pycache__/**" --reload-exclude "**/.git/**" --reload-exclude "**/node_modules/**" --host 0.0.0.0 --port 8000
```

The backend will start on http://localhost:8000

### Terminal 2 - Frontend

```bash
cd "/Users/joshuaedwards/Library/CloudStorage/GoogleDrive-jedwards@che.school/My Drive/CHE/che-data-integrity-monitor/frontend"
npm run dev
```

The frontend will start on http://localhost:5173

## What Was Fixed

### Auto-Login Behavior

- The app automatically attempts to sign you in when you load the page (line 97-106 in `AuthGuard.tsx`)
- This is intentional for development convenience
- You don't need to click the "Skip Sign-In" button - it happens automatically on page load

### Debug Information Added

The "Access Denied" page now shows:

- **Email**: The email of the logged-in user
- **UID**: The Firebase user ID
- **Admin Status**: Whether the user has admin privileges
- **Instructions**: How to grant admin access in Firestore

### Next Steps When You See "Access Denied"

1. The page will show your UID (e.g., `VREuQrovBgfFchFsblPRJRbvRUx2`)
2. Use that UID to run:
   ```bash
   cd backend
   python setup_admin_user.py your-email@che.school YOUR_UID_HERE
   ```
3. Or manually add to Firestore:
   - Go to Firebase Console > Firestore
   - Collection: `users`
   - Document ID: `YOUR_UID_HERE`
   - Add field: `isAdmin` = `true` (boolean)

## Troubleshooting

### If auto-login fails

- Check browser console (F12) for errors
- Verify backend is running: `curl http://localhost:8000/health`
- Test auth endpoint: `curl 'http://localhost:8000/auth/dev-token?email=jedwards@che.school'`

### If you get "Access Denied"

- Look at the debug info on the page
- Note your UID
- Run `python backend/setup_admin_user.py <email> <uid>` to grant admin access

### To stop the servers

Press `Ctrl+C` in each terminal window
