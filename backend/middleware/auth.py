"""Authentication middleware for securing API endpoints."""

from __future__ import annotations

import hashlib
import logging
import os
import time
from typing import Optional

from fastapi import Header, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

logger = logging.getLogger(__name__)

security = HTTPBearer()


def _get_firebase_admin():
    """Get or initialize Firebase Admin SDK."""
    try:
        import firebase_admin
        from firebase_admin import auth as admin_auth, credentials
        
        # Initialize if not already initialized
        if not firebase_admin._apps:
            # Get project ID from environment or default to frontend project
            project_id = os.getenv("GOOGLE_CLOUD_PROJECT") or os.getenv("GCP_PROJECT_ID") or "data-integrity-monitor"
            
            cred_path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
            if cred_path:
                if not os.path.isabs(cred_path):
                    backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
                    cred_path = os.path.join(backend_dir, cred_path)
                    if not os.path.exists(cred_path):
                        cred_path = os.path.abspath(os.getenv("GOOGLE_APPLICATION_CREDENTIALS"))
                
                if os.path.exists(cred_path):
                    cred = credentials.Certificate(cred_path)
                    import json
                    with open(cred_path, 'r') as f:
                        sa_data = json.load(f)
                        # Use project_id from service account if available, otherwise use env/default
                        project_id = sa_data.get('project_id') or project_id
                    firebase_admin.initialize_app(cred, {'projectId': project_id})
                else:
                    # Service account file not found, use ApplicationDefault but set project ID
                    cred = credentials.ApplicationDefault()
                    firebase_admin.initialize_app(cred, {'projectId': project_id})
            else:
                # No GOOGLE_APPLICATION_CREDENTIALS, use ApplicationDefault but set project ID
                cred = credentials.ApplicationDefault()
                firebase_admin.initialize_app(cred, {'projectId': project_id})
        
        return admin_auth
    except ImportError:
        logger.warning("Firebase Admin SDK not available")
        return None
    except Exception as exc:
        logger.warning(f"Failed to initialize Firebase Admin: {exc}")
        return None


def verify_firebase_token(authorization: Optional[str] = Header(None)) -> dict:
    """Verify Firebase ID token from Authorization header.
    
    Args:
        authorization: Authorization header value (format: "Bearer <token>")
    
    Returns:
        Decoded token claims (dict with user info)
    
    Raises:
        AuthenticationError: If token is missing or invalid
    """
    if not authorization:
        raise AuthenticationError("Missing Authorization header")
    
    if not authorization.startswith("Bearer "):
        raise AuthenticationError("Invalid Authorization header format. Expected 'Bearer <token>'")
    
    token = authorization[7:]  # Remove "Bearer " prefix
    
    if not token:
        raise AuthenticationError("Missing bearer token")
    
    admin_auth = _get_firebase_admin()
    
    if not admin_auth:
        raise AuthenticationError("Firebase authentication not configured")
    
    try:
        decoded_token = admin_auth.verify_id_token(token)
        logger.info("Firebase token verified", extra={"uid": decoded_token.get("uid")})
        return decoded_token
    except Exception as exc:
        logger.warning(
            "Firebase token verification failed",
            extra={"error": str(exc)},
        )
        raise AuthenticationError("Invalid or expired Firebase token")


class AuthenticationError(HTTPException):
    """Custom exception for authentication failures."""

    def __init__(self, detail: str):
        super().__init__(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=detail,
            headers={"WWW-Authenticate": "Bearer"},
        )


def verify_bearer_token(authorization: Optional[str] = Header(None)) -> str:
    """Verify bearer token from Authorization header.

    Args:
        authorization: Authorization header value (format: "Bearer <token>")

    Returns:
        The validated token

    Raises:
        AuthenticationError: If token is missing or invalid
    """
    if not authorization:
        raise AuthenticationError("Missing Authorization header")

    if not authorization.startswith("Bearer "):
        raise AuthenticationError("Invalid Authorization header format. Expected 'Bearer <token>'")

    token = authorization[7:]  # Remove "Bearer " prefix

    if not token:
        raise AuthenticationError("Missing bearer token")

    # Get expected token from environment
    expected_token = os.getenv("API_AUTH_TOKEN")

    if not expected_token:
        logger.error("API_AUTH_TOKEN environment variable not set")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Server authentication not configured",
        )

    if token != expected_token:
        logger.warning(
            "Invalid authentication token attempt",
            extra={"token_prefix": token[:8] if len(token) >= 8 else token},
        )
        raise AuthenticationError("Invalid bearer token")

    return token


def verify_api_key_or_bearer_token(authorization: Optional[str] = Header(None)) -> str:
    """Verify bearer token: accepts static API_AUTH_TOKEN or per-user API keys.

    Checks static API_AUTH_TOKEN first (fast path), then falls back to
    looking up a per-user API key hash in Firestore.

    Returns:
        The validated token

    Raises:
        AuthenticationError: If token is missing or invalid
    """
    if not authorization:
        raise AuthenticationError("Missing Authorization header")

    if not authorization.startswith("Bearer "):
        raise AuthenticationError("Invalid Authorization header format. Expected 'Bearer <token>'")

    token = authorization[7:]
    if not token:
        raise AuthenticationError("Missing bearer token")

    # Fast path: check static API_AUTH_TOKEN
    expected_token = os.getenv("API_AUTH_TOKEN")
    if expected_token and token == expected_token:
        return token

    # Slow path: check per-user API key in Firestore
    try:
        from google.cloud import firestore as firestore_lib

        key_hash = hashlib.sha256(token.encode()).hexdigest()
        db = firestore_lib.Client()
        query = db.collection_group("api_keys").where("key_hash", "==", key_hash).limit(1)
        docs = list(query.stream())

        if docs:
            # Update last_used_at (best-effort)
            try:
                docs[0].reference.update({"last_used_at": firestore_lib.SERVER_TIMESTAMP})
            except Exception:
                pass
            return token
    except Exception as exc:
        logger.warning(f"API key lookup failed: {exc}")

    # Final fallback: try Firebase ID token (for frontend access)
    admin_auth = _get_firebase_admin()
    if admin_auth:
        try:
            admin_auth.verify_id_token(token)
            return token
        except Exception:
            pass

    raise AuthenticationError("Invalid bearer token")


def verify_cloud_scheduler_auth(
    x_cloudscheduler: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
) -> None:
    """Verify request is from Cloud Scheduler or has valid bearer token.

    Cloud Scheduler automatically adds X-CloudScheduler header.
    Alternatively, accepts Firebase token or API_AUTH_TOKEN authentication.

    Args:
        x_cloudscheduler: X-CloudScheduler header (added by Cloud Scheduler)
        authorization: Authorization header (for manual/external calls)

    Raises:
        AuthenticationError: If neither Cloud Scheduler header nor valid token present
    """
    # Check for Cloud Scheduler header
    if x_cloudscheduler:
        logger.info("Request authenticated via Cloud Scheduler header")
        return

    # Try Firebase token verification first (for frontend requests)
    firebase_error = None
    try:
        verify_firebase_token(authorization)
        logger.info("Request authenticated via Firebase token")
        return
    except AuthenticationError as e:
        firebase_error = e
        # Continue to try API_AUTH_TOKEN as fallback

    # Fall back to API_AUTH_TOKEN check (legacy/development)
    try:
        verify_bearer_token(authorization)
        logger.info("Request authenticated via API_AUTH_TOKEN")
        return
    except AuthenticationError:
        # If both fail, raise the Firebase error (more descriptive for frontend users)
        if firebase_error:
            raise firebase_error
        raise AuthenticationError("Authentication failed")


def verify_service_account_token(authorization: Optional[str] = Header(None)) -> str:
    """Verify service account JWT token (for Cloud Run invocations).

    This is a simplified version. For production, should validate JWT signature
    and claims using google.auth or similar library.

    Args:
        authorization: Authorization header with bearer token

    Returns:
        The validated token

    Raises:
        AuthenticationError: If token is invalid
    """
    return verify_bearer_token(authorization)
