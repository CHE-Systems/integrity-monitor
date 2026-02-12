# Firebase Authentication Setup Guide

This guide will help you set up Firebase Authentication for the CHE Data Integrity Monitor.

## Prerequisites

You mentioned you've already:

- ✅ Enabled Authentication API in Google Cloud
- ✅ Enabled Authentication in Firebase Console
- ✅ Enabled Google Sign-in and Email/Password in Firebase

## Steps to Fix Authentication Issues

### 1. Verify Identity Toolkit API is Enabled

The Firebase Authentication API uses the Identity Toolkit API under the hood. Even if you've enabled it, it can take 1-2 minutes to propagate.

1. Go to: https://console.cloud.google.com/apis/library/identitytoolkit.googleapis.com?project=data-integrity-monitor
2. Ensure it shows as **"API Enabled"** (not just a button to enable)
3. If you just enabled it, wait 2-3 minutes for it to fully propagate

### 2. Verify Firebase Authentication is Set Up

1. Go to: https://console.firebase.google.com/project/data-integrity-monitor/authentication
2. Click "Get Started" if you haven't already
3. Enable **Email/Password** sign-in method
4. Enable **Google** sign-in method (add your support email)

### 3. Verify Service Account Permissions

Your service account needs the right permissions:

```bash
# Check current roles (run from project root)
gcloud projects get-iam-policy data-integrity-monitor \
  --flatten="bindings[].members" \
  --filter="bindings.members:firebase-adminsdk-fbsvc@data-integrity-monitor.iam.gserviceaccount.com"
```

The service account should have:

- `roles/firebase.admin` or
- `roles/firebaseauth.admin`

To add if missing:

```bash
gcloud projects add-iam-policy-binding data-integrity-monitor \
  --member="serviceAccount:firebase-adminsdk-fbsvc@data-integrity-monitor.iam.gserviceaccount.com" \
  --role="roles/firebase.admin"
```

### 4. Test the Backend Endpoint

Once the API is enabled and propagated, test the dev-token endpoint:

```bash
# Make sure your backend is running
cd backend
source .venv/bin/activate
uvicorn main:app --reload

# In another terminal, test the endpoint
curl http://localhost:8000/auth/dev-token?email=jedwards@che.school
```

Expected success response:

```json
{
  "token": "[REDACTED - Example JWT token]"
}
```

### 5. Test the Frontend Auto-Login

1. Start the frontend dev server:

   ```bash
   cd frontend
   npm run dev
   ```

2. Open http://localhost:5173 in your browser
3. The app should automatically attempt to sign you in as `jedwards@che.school`
4. Check the browser console for any errors

## Troubleshooting

### Error: "Firebase Authentication API is not enabled"

**Solution:** Wait 2-3 minutes after enabling the Identity Toolkit API, then try again. The API can take time to propagate.

### Error: "Failed to initialize Firebase Admin"

**Solution:** Check that `GOOGLE_APPLICATION_CREDENTIALS` points to the correct service account file:

```bash
cd backend
cat .env | grep GOOGLE_APPLICATION_CREDENTIALS
ls -la data-integrity-service-account2.json
```

### Error: "Permission denied" when creating user

**Solution:** Verify service account has `roles/firebase.admin` permission (see Step 3 above).

### Auto-login not working in frontend

**Solution:**

1. Check that backend is running on http://localhost:8000
2. Open browser DevTools > Network tab
3. Look for request to `/auth/dev-token`
4. Check the response for errors

## Security Note

The `/auth/dev-token` endpoint is **development only** and is automatically disabled in production. It only works when:

- `NODE_ENV` is not "production", OR
- `ENVIRONMENT` environment variable is set to "dev", "development", or "local"

## Next Steps

Once authentication is working:

1. Create an admin user in Firestore:

   ```
   Collection: users
   Document ID: {your-user-uid}
   Fields:
     - email: "jedwards@che.school"
     - isAdmin: true
   ```

2. The app checks `isAdmin` field in Firestore to grant dashboard access

## Getting Your User UID

After successfully signing in once, check the browser console. The UID will be logged, or you can find it in Firebase Console under Authentication > Users.
