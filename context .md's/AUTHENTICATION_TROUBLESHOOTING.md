# Authentication Troubleshooting - What Actually Worked

## The Problem

User was getting "Access Denied" even though:
- Firebase Authentication was working
- User was successfully signed in
- Firestore had the correct `isAdmin: true` field
- The UID matched

## What We Tried (That Didn't Work)

### ❌ Attempt 1: Enable Identity Toolkit API
- **What we did**: Enabled the Identity Toolkit API in Google Cloud Console
- **Why we thought it would work**: The backend was returning errors about the API not being enabled
- **Why it failed**: The API was already enabled, just took time to propagate
- **Outcome**: This was actually already working, wasn't the root cause

### ❌ Attempt 2: Fix Backend Service Account Loading
- **What we did**: Added explicit `.env` file loading in `backend/main.py`
- **Why we thought it would work**: Backend was using wrong Firebase project (`che-message-compliance`)
- **Why it succeeded**: This DID fix the backend issue - custom token generation started working
- **But**: This alone didn't fix the "Access Denied" issue

### ❌ Attempt 3: Setup Admin User in Firestore
- **What we did**: Ran `setup_admin_user.py` to set `isAdmin: true`
- **Why we thought it would work**: User document would have admin privileges
- **Why it failed**: Firestore security rules were blocking the frontend from reading the document
- **Outcome**: The document was created correctly, but couldn't be read

### ❌ Attempt 4: Add Debug Logging
- **What we did**: Added console.log statements to track auth flow
- **Why we thought it would work**: Would help us see what's happening
- **Why it helped**: Revealed the actual error: `FirebaseError: Missing or insufficient permissions`
- **Outcome**: This led us to the real issue!

## ✅ The Actual Fix: Deploy Firestore Security Rules

### What Was Wrong
The Firestore security rules in `firestore.rules` existed locally but were **never deployed** to Firebase. The frontend couldn't read from Firestore because the deployed rules were either:
- Non-existent (denying all access), OR
- Expired (the default 30-day test rules had expired)

### The Solution
1. **Updated** `firestore.rules` to allow authenticated users to read their own user documents
2. **Deployed** the rules: `firebase deploy --only firestore:rules`

### The Fixed Rules
```javascript
rules_version = '2';

service cloud.firestore {
  match /databases/{database}/documents {
    // Users collection - authenticated users can read their own document
    match /users/{userId} {
      allow read: if request.auth != null && request.auth.uid == userId;
      allow write: if request.auth != null && request.auth.uid == userId;
    }

    // Allow authenticated users to query users collection by email
    match /users/{userId} {
      allow read: if request.auth != null;
    }

    // All other collections - require authentication
    match /{document=**} {
      allow read, write: if request.auth != null;
    }
  }
}
```

## Why This Was The Issue

The authentication flow works like this:

1. ✅ Frontend calls backend `/auth/dev-token`
2. ✅ Backend generates Firebase custom token
3. ✅ Frontend signs in with custom token
4. ✅ Firebase Authentication succeeds
5. ❌ **Frontend tries to read Firestore `users/{uid}` document**
6. ❌ **Firestore rules reject the read (no rules deployed!)**
7. ❌ Error: "Missing or insufficient permissions"
8. ❌ Frontend sets `isAdmin = false` due to error
9. ❌ User sees "Access Denied"

After deploying rules:

1. ✅ Frontend calls backend `/auth/dev-token`
2. ✅ Backend generates Firebase custom token
3. ✅ Frontend signs in with custom token
4. ✅ Firebase Authentication succeeds
5. ✅ **Frontend reads Firestore `users/{uid}` document (rules allow it!)**
6. ✅ **Firestore returns `{email: "...", isAdmin: true}`**
7. ✅ Frontend sets `isAdmin = true`
8. ✅ User sees Dashboard!

## Key Lessons

1. **Firestore rules must be deployed** - Having them in your codebase isn't enough
2. **Test rules are temporary** - Default rules expire after 30 days
3. **Backend auth ≠ Firestore access** - Firebase Authentication and Firestore permissions are separate
4. **Debug logging is critical** - Without the console logs, we wouldn't have seen the permission error
5. **Check deployed state** - Always verify what's actually deployed vs. what's in your code

## Other Fixes Applied

While troubleshooting, we also fixed:

### Auto-Login Disabled
- **File**: `frontend/src/components/AuthGuard.tsx:119-128`
- **Change**: Commented out the `useEffect` that auto-triggered sign-in
- **Result**: User must now click "Skip Sign-In (Dev)" button

### Backend Environment Loading
- **File**: `backend/main.py:8-11`
- **Change**: Added explicit `.env` file loading
- **Result**: Backend always uses correct service account file

### Debug Information on Access Denied Page
- **File**: `frontend/src/components/AuthGuard.tsx:56-73`
- **Change**: Added debug box showing email, UID, and admin status
- **Result**: Easier to diagnose auth issues in the future

## Commands Used

### Deploy Firestore Rules
```bash
firebase deploy --only firestore:rules
```

### Test Backend Auth Endpoint
```bash
curl 'http://localhost:8000/auth/dev-token?email=jedwards@che.school'
```

### Setup Admin User
```bash
cd backend
python setup_admin_user.py jedwards@che.school VREuQrovBgfFchFsblPRJRbvRUx2
```

### Test Firebase Auth Setup
```bash
cd backend
python test_firebase_auth.py
```

## Final Working State

- ✅ Backend: Loads correct service account, generates tokens
- ✅ Frontend: Signs in with custom token
- ✅ Firestore Rules: Deployed and allow authenticated access
- ✅ Admin User: Document exists with `isAdmin: true`
- ✅ Dashboard: User can access with admin privileges

The fix was simple in the end - just needed to deploy the Firestore rules! 🎉
