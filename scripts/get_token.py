#!/usr/bin/env python3
"""
Simple script to get Firebase ID token for API testing.
Usage: python scripts/get_token.py
"""

import requests
import json
import sys
import os

# Try to load from .env if python-dotenv is available
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

BACKEND_URL = os.getenv("BACKEND_URL", "http://localhost:8000")
EMAIL = os.getenv("EMAIL", "jedwards@che.school")

def get_custom_token():
    """Get custom token from backend dev-token endpoint."""
    url = f"{BACKEND_URL}/auth/dev-token"
    params = {"email": EMAIL}
    
    try:
        response = requests.get(url, params=params, timeout=10)
        response.raise_for_status()
        data = response.json()
        return data.get("token")
    except requests.exceptions.RequestException as e:
        print(f"Error getting custom token: {e}")
        if hasattr(e, 'response') and e.response is not None:
            print(f"Response: {e.response.text}")
        sys.exit(1)

def exchange_for_id_token(custom_token):
    """Exchange custom token for ID token using Firebase Admin SDK."""
    try:
        import firebase_admin
        from firebase_admin import auth, credentials
        
        # Initialize Firebase Admin if not already initialized
        if not firebase_admin._apps:
            cred_path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
            if cred_path and os.path.exists(cred_path):
                cred = credentials.Certificate(cred_path)
                firebase_admin.initialize_app(cred)
            else:
                cred = credentials.ApplicationDefault()
                project_id = os.getenv("GOOGLE_CLOUD_PROJECT") or "data-integrity-monitor"
                firebase_admin.initialize_app(cred, {'projectId': project_id})
        
        # Create a user and sign in with custom token
        # Actually, we need to use the Firebase REST API to exchange the token
        # Firebase Admin SDK doesn't have a direct way to exchange custom token for ID token
        
        # Use Firebase REST API instead
        import firebase_admin
        from firebase_admin import auth as admin_auth
        
        # Get the project ID
        app = firebase_admin.get_app()
        project_id = app.project_id
        
        # Use Firebase REST API to exchange custom token
        # This requires the Firebase API key from the frontend config
        api_key = os.getenv("VITE_FIREBASE_API_KEY")
        if not api_key:
            print("Error: VITE_FIREBASE_API_KEY not found in environment")
            print("Please set it or check your .env file")
            sys.exit(1)
        
        # Exchange custom token for ID token via Firebase REST API
        exchange_url = f"https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key={api_key}"
        payload = {
            "token": custom_token,
            "returnSecureToken": True
        }
        
        response = requests.post(exchange_url, json=payload, timeout=10)
        response.raise_for_status()
        data = response.json()
        
        return data.get("idToken")
        
    except ImportError:
        print("Error: firebase-admin not installed")
        print("Install it with: pip install firebase-admin")
        sys.exit(1)
    except Exception as e:
        print(f"Error exchanging token: {e}")
        sys.exit(1)

def main():
    print("Getting Firebase ID token...")
    print(f"Backend URL: {BACKEND_URL}")
    print(f"Email: {EMAIL}")
    print()
    
    # Step 1: Get custom token
    print("Step 1: Getting custom token from backend...")
    custom_token = get_custom_token()
    if not custom_token:
        print("Error: Failed to get custom token")
        sys.exit(1)
    print("✓ Custom token received")
    print()
    
    # Step 2: Exchange for ID token
    print("Step 2: Exchanging for ID token...")
    id_token = exchange_for_id_token(custom_token)
    if not id_token:
        print("Error: Failed to get ID token")
        sys.exit(1)
    print("✓ ID token received")
    print()
    
    # Output the token
    print("=" * 60)
    print("Your Firebase ID Token:")
    print("=" * 60)
    print(id_token)
    print()
    print("=" * 60)
    print("Use it in curl:")
    print("=" * 60)
    print(f'curl -H "Authorization: Bearer {id_token}" \\')
    print(f"  {BACKEND_URL}/admin/school-years/current")
    print()

if __name__ == "__main__":
    main()

