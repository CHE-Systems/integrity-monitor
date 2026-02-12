# Quick Start Guide

## Authentication Setup - COMPLETE! ✅

Your authentication is now fully configured and working! Here's what was set up:

### What's Working:
- ✅ Firebase Authentication API is enabled
- ✅ User `jedwards@che.school` exists (UID: `VREuQrovBgfFchFsblPRJRbvRUx2`)
- ✅ Admin privileges granted in Firestore
- ✅ Auto-login feature is ready to use

## Testing the Auto-Login Feature

### 1. Start the Backend Server

```bash
cd backend
source .venv/bin/activate  # or: .venv\Scripts\activate on Windows
uvicorn main:app --reload
```

The backend should start on http://localhost:8000

### 2. Start the Frontend Dev Server

In a new terminal:

```bash
cd frontend
npm run dev
```

The frontend should start on http://localhost:5173

### 3. Open Your Browser

1. Navigate to http://localhost:5173
2. The app will automatically attempt to sign you in as `jedwards@che.school`
3. If successful, you'll be taken directly to the dashboard (no password required!)

### 4. What Should Happen

When you open the app:
1. The login form appears briefly
2. The "Skip Sign-In (Dev)" button is visible (in development mode only)
3. The app automatically calls the backend `/auth/dev-token` endpoint
4. Firebase signs you in with the custom token
5. The app checks your admin status in Firestore
6. You're redirected to the dashboard!

## Troubleshooting

### Auto-login isn't working

1. **Check the backend is running**: Visit http://localhost:8000/health - should return `{"status": "ok"}`

2. **Check the dev-token endpoint**:
   ```bash
   curl http://localhost:8000/auth/dev-token?email=jedwards@che.school
   ```
   Should return a JSON object with a `token` field.

3. **Check browser console**: Open DevTools (F12) > Console tab
   - Look for any error messages
   - Check the Network tab for failed requests to `/auth/dev-token`

4. **Verify environment variables**:
   ```bash
   cd frontend
   cat .env.local | grep VITE_API_BASE
   ```
   Should show: `VITE_API_BASE=http://localhost:8000`

### Manual Login (If Auto-Login Fails)

If auto-login doesn't work, you can manually click the "Skip Sign-In (Dev)" button on the login screen.

## Diagnostic Tools

We've created two helpful diagnostic scripts:

### Test Firebase Authentication
```bash
cd backend
python test_firebase_auth.py
```

This will check:
- Firebase Admin SDK installation
- Service account configuration
- Firebase Authentication API status
- Custom token generation

### Setup Admin User
```bash
cd backend
python setup_admin_user.py [email] [uid]
```

This will create or update a user with admin privileges in Firestore.

## Production Deployment

**IMPORTANT:** The auto-login feature is **development only** and will not work in production.

In production:
- The `/auth/dev-token` endpoint returns 403 Forbidden
- Users must sign in with Google OAuth or Email/Password
- The "Skip Sign-In (Dev)" button is hidden

## Next Steps

Now that authentication is working, you can:

1. **Customize the auto-login email**: Edit `frontend/src/components/AuthGuard.tsx` line 140 to change the email
2. **Add more admin users**: Run `python setup_admin_user.py <email> <uid>`
3. **Enable Google Sign-In**: Test the "Sign in with Google" button (requires OAuth consent screen setup)
4. **Deploy to production**: Follow the deployment guide in `AUTHENTICATION_SETUP.md`

## Files Modified/Created

- ✅ `AUTHENTICATION_SETUP.md` - Detailed setup guide
- ✅ `QUICK_START.md` - This file
- ✅ `backend/test_firebase_auth.py` - Diagnostic tool
- ✅ `backend/setup_admin_user.py` - Admin user setup tool

## Support

If you encounter any issues:
1. Run `python backend/test_firebase_auth.py` to diagnose
2. Check browser console for errors
3. Verify backend logs for error messages

Your authentication is fully configured and ready to use! 🎉
