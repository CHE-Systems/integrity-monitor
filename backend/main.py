import logging
import os
import json
import time
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional, Dict, Any
from fastapi import FastAPI, HTTPException, Request, status, Depends, Query, Body
from fastapi.middleware.cors import CORSMiddleware
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, ValidationError
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

# Load environment variables from backend/.env
from dotenv import load_dotenv
backend_dir = Path(__file__).parent
load_dotenv(backend_dir / ".env")

from .config.schema_loader import load_schema_config
from .middleware.auth import verify_bearer_token, verify_cloud_scheduler_auth, verify_firebase_token
from .services.integrity_runner import IntegrityRunner

from .services.airtable_schema_service import schema_service
from .services.integrity_metrics_service import get_metrics_service
from .services.table_id_discovery import discover_table_ids, validate_discovered_ids
from .services.config_updater import update_config
from .services.rules_service import RulesService
from .services.ai_rule_parser import AIRuleParser
from .utils.errors import IntegrityRunError

logger = logging.getLogger(__name__)

app = FastAPI()

# CORS configuration - restrict origins in production
allowed_origins_env = os.getenv("ALLOWED_ORIGINS", "")
if allowed_origins_env:
    allowed_origins = [origin.strip() for origin in allowed_origins_env.split(",")]
else:
    # Default for local development: allow localhost frontend
    allowed_origins = ["http://localhost:5173", "http://127.0.0.1:5173"]

# For wildcard, we can't use credentials, so disable credentials
use_credentials = "*" not in allowed_origins

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=use_credentials,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


class RequestIDMiddleware(BaseHTTPMiddleware):
    """Add request ID to logs for tracing."""

    async def dispatch(self, request: Request, call_next):
        import uuid
        request_id = str(uuid.uuid4())
        request.state.request_id = request_id
        response = await call_next(request)
        response.headers["X-Request-ID"] = request_id
        return response


app.add_middleware(RequestIDMiddleware)

# #region agent log
try:
    with open(debug_log, 'a') as f:
        f.write(json.dumps({"sessionId":"debug-session","runId":"startup","hypothesisId":"A","location":"main.py:104","message":"Starting schema config load","data":{"step":"before_load_schema_config"},"timestamp":int(time.time()*1000)})+'\n')
except: pass
# #endregion agent log

# Load schema config with error handling
try:
    schema_config = load_schema_config()
    logger.info("Schema config loaded successfully")
except Exception as e:
    logger.error(f"Failed to load schema config: {e}", exc_info=True)
    # Create a minimal schema config to allow app to start
    from .config.models import SchemaConfig
    schema_config = SchemaConfig(entities={})
    logger.warning("Using empty schema config due to load failure")

# #region agent log
try:
    with open(debug_log, 'a') as f:
        f.write(json.dumps({"sessionId":"debug-session","runId":"startup","hypothesisId":"B","location":"main.py:120","message":"Schema config loaded, starting IntegrityRunner init","data":{"step":"before_integrity_runner","schema_loaded":True},"timestamp":int(time.time()*1000)})+'\n')
except: pass
# #endregion agent log

# Initialize IntegrityRunner with error handling
try:
    runner = IntegrityRunner()
    logger.info("IntegrityRunner initialized successfully")
except Exception as e:
    logger.error(f"Failed to initialize IntegrityRunner: {e}", exc_info=True)
    # Set runner to None - endpoints that need it will handle the error
    runner = None
    logger.warning("IntegrityRunner not available - some endpoints may fail")

# Global dictionary to track running scans: {run_id: threading.Event}
running_scans: dict[str, threading.Event] = {}
running_scans_lock = threading.Lock()

# #region agent log
try:
    with open(debug_log, 'a') as f:
        f.write(json.dumps({"sessionId":"debug-session","runId":"startup","hypothesisId":"C","location":"main.py:135","message":"Startup complete","data":{"step":"after_integrity_runner","runner_available":runner is not None},"timestamp":int(time.time()*1000)})+'\n')
except: pass
# #endregion agent log

logger.info("FastAPI application startup complete")


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    """Log validation errors for debugging."""
    logger.error(
        "Request validation error",
        extra={
            "url": str(request.url),
            "method": request.method,
            "errors": exc.errors(),
            "body": await request.body() if request.method in ["POST", "PUT", "PATCH"] else None,
        },
    )
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content={"detail": exc.errors(), "body": exc.body},
    )


@app.on_event("startup")
async def startup_event():
    """Log when the application is ready to accept requests."""
    import sys
    logger.info(
        "Application startup event triggered",
        extra={
            "python_version": sys.version,
            "port": os.getenv("PORT", "8080"),
            "runner_available": runner is not None,
            "schema_loaded": schema_config is not None,
        }
    )


@app.on_event("shutdown")
async def shutdown_event():
    """Log when the application is shutting down."""
    logger.info("Application shutdown event triggered")


@app.get("/health")
def health():
    """Health check endpoint - should always respond even if other services fail."""
    return {
        "status": "ok",
        "runner_available": runner is not None,
        "schema_loaded": schema_config is not None,
    }


@app.get("/auth/dev-token")
def get_dev_token(email: str = "jedwards@che.school"):
    """Generate a custom Firebase auth token for development.
    
    WARNING: This endpoint should only be enabled in development environments.
    It allows bypassing normal authentication.
    
    Args:
        email: Email address to generate token for (default: jedwards@che.school)
    
    Returns:
        Dictionary with custom token
    """
    import os
    
    # Only allow in development
    if os.getenv("ENVIRONMENT", "dev") not in ["dev", "development", "local"]:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Dev token endpoint not available in production",
        )
    
    try:
        # Try to use Firebase Admin SDK to create custom token
        try:
            import firebase_admin
            from firebase_admin import auth as admin_auth, credentials
        except ImportError as import_err:
            # Firebase Admin SDK not installed - return error
            logger.error("Firebase Admin SDK import failed", extra={"error": str(import_err)}, exc_info=True)
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Firebase Admin SDK not available. Install with: pip install firebase-admin. Error: {str(import_err)}",
            )
        
        # Initialize Firebase Admin if not already initialized
        try:
            if not firebase_admin._apps:
                # Try to get credentials from environment
                cred_path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
                if cred_path:
                    # Resolve relative paths relative to backend directory
                    if not os.path.isabs(cred_path):
                        # Get backend directory (where this file is located)
                        backend_dir = os.path.dirname(os.path.abspath(__file__))
                        cred_path = os.path.join(backend_dir, cred_path)
                        # Also try resolving relative to current working directory
                        if not os.path.exists(cred_path):
                            cred_path = os.path.abspath(os.getenv("GOOGLE_APPLICATION_CREDENTIALS"))
                    
                    if os.path.exists(cred_path):
                        cred = credentials.Certificate(cred_path)
                        # Get project ID from credentials for logging
                        import json
                        with open(cred_path, 'r') as f:
                            sa_data = json.load(f)
                            project_id = sa_data.get('project_id', 'unknown')
                        firebase_admin.initialize_app(cred, {'projectId': project_id})
                        logger.info("Firebase Admin initialized", extra={"path": cred_path, "project_id": project_id})
                    else:
                        logger.warning(f"Service account file not found at {cred_path}, trying default credentials")
                        cred = credentials.ApplicationDefault()
                        firebase_admin.initialize_app(cred)
                else:
                    # Use default credentials (for Cloud Run, etc.)
                    try:
                        cred = credentials.ApplicationDefault()
                        firebase_admin.initialize_app(cred)
                    except Exception as cred_err:
                        logger.error("Failed to initialize Firebase with default credentials", extra={"error": str(cred_err)}, exc_info=True)
                        raise HTTPException(
                            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                            detail=f"Failed to initialize Firebase Admin. Set GOOGLE_APPLICATION_CREDENTIALS or ensure default credentials are available. Error: {str(cred_err)}",
                        )
        except ValueError as ve:
            # App already initialized
            if "already exists" not in str(ve).lower():
                raise
        
        # Get the project ID being used for better error messages
        try:
            app = firebase_admin.get_app()
            project_id = app.project_id if hasattr(app, 'project_id') else 'unknown'
        except:
            project_id = 'unknown'
        
        # Get user by email to get UID, or create user if doesn't exist
        try:
            user = admin_auth.get_user_by_email(email)
            uid = user.uid
            logger.info("Found existing user", extra={"email": email, "uid": uid})
        except admin_auth.UserNotFoundError:
            # Create user if doesn't exist
            try:
                user = admin_auth.create_user(email=email)
                uid = user.uid
                logger.info("Created new user", extra={"email": email, "uid": uid})
            except Exception as create_err:
                error_msg = str(create_err)
                logger.error("Failed to create user", extra={"email": email, "error": error_msg, "project_id": project_id}, exc_info=True)
                
                # Check if it's a configuration error
                if "CONFIGURATION_NOT_FOUND" in error_msg or "ConfigurationNotFoundError" in str(type(create_err).__name__):
                    detail_msg = (
                        f"Firebase Authentication API is not enabled for project '{project_id}'. "
                        f"Please verify:\n"
                        f"1. Go to https://console.cloud.google.com/apis/library/identitytoolkit.googleapis.com?project={project_id}\n"
                        f"2. Ensure the API shows as 'Enabled' (may take 1-2 minutes to propagate)\n"
                        f"3. Verify Firebase Authentication is enabled in Firebase Console: https://console.firebase.google.com/project/{project_id}/authentication\n"
                        f"4. Enable Email/Password sign-in method in Firebase Console\n"
                        f"5. Ensure your service account has 'Firebase Admin SDK Administrator Service Agent' role"
                    )
                else:
                    detail_msg = f"Failed to create user: {error_msg}"
                
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail=detail_msg,
                )
        except Exception as lookup_err:
            # Handle ConfigurationNotFoundError or other lookup errors
            error_str = str(lookup_err)
            if "CONFIGURATION_NOT_FOUND" in error_str or "ConfigurationNotFoundError" in str(type(lookup_err).__name__):
                # Try creating user directly - might work if Auth is partially configured
                try:
                    user = admin_auth.create_user(email=email)
                    uid = user.uid
                    logger.info("Created user after configuration error", extra={"email": email, "uid": uid})
                except Exception as create_err:
                    error_msg = str(create_err)
                    logger.error("Failed to create user after configuration error", extra={"email": email, "error": error_msg, "project_id": project_id}, exc_info=True)
                    
                    # Provide more specific guidance based on error
                    if "CONFIGURATION_NOT_FOUND" in error_msg or "ConfigurationNotFoundError" in str(type(create_err).__name__):
                        detail_msg = (
                            f"Firebase Authentication API is not enabled for project '{project_id}'. "
                            f"Please verify:\n"
                            f"1. Go to https://console.cloud.google.com/apis/library/identitytoolkit.googleapis.com?project={project_id}\n"
                            f"2. Ensure the API shows as 'Enabled' (may take 1-2 minutes to propagate)\n"
                            f"3. Verify Firebase Authentication is enabled in Firebase Console: https://console.firebase.google.com/project/{project_id}/authentication\n"
                            f"4. Enable Email/Password sign-in method in Firebase Console\n"
                            f"5. Ensure your service account has 'Firebase Admin SDK Administrator Service Agent' role"
                        )
                    else:
                        detail_msg = f"Failed to create user: {error_msg}"
                    
                    raise HTTPException(
                        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                        detail=detail_msg,
                    )
            else:
                # Re-raise other lookup errors
                raise
        
        # Create custom token using UID
        custom_token = admin_auth.create_custom_token(uid)
        return {"token": custom_token.decode() if isinstance(custom_token, bytes) else custom_token}
    except HTTPException:
        # Re-raise HTTP exceptions
        raise
    except Exception as exc:
        logger.error("Failed to generate dev token", extra={"email": email, "error": str(exc)}, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to generate dev token: {str(exc)}",
        )


@app.get("/schema", dependencies=[Depends(verify_bearer_token)])
def schema():
    """Expose the current schema configuration (requires authentication)."""
    if schema_config is None:
        raise HTTPException(status_code=500, detail="Schema config not loaded")
    return schema_config.model_dump()


def _run_integrity_background(
    run_id: str,
    trigger: str,
    cancel_event: threading.Event,
    entities: Optional[List[str]] = None,
    run_config: Optional[Dict[str, Any]] = None
):
    """Run integrity scan in background thread."""
    try:
        # Create a new runner instance for this thread
        if runner is None:
            logger.error("IntegrityRunner not available - cannot start scan", extra={"run_id": run_id})
            return
        thread_runner = IntegrityRunner()
        result = thread_runner.run(
            run_id=run_id,
            trigger=trigger,
            cancel_event=cancel_event,
            entities=entities,
            run_config=run_config
        )
        logger.info(
            "Integrity run completed",
            extra={"run_id": run_id, "status": result.get("status", "success")},
        )
    except Exception as exc:
        logger.error(
            "Integrity run failed",
            extra={"run_id": run_id, "error": str(exc)},
            exc_info=True,
        )
    finally:
        # Clean up running scan tracking
        with running_scans_lock:
            running_scans.pop(run_id, None)


@app.post("/integrity/run", dependencies=[Depends(verify_cloud_scheduler_auth)])
def run_integrity(
    request: Request,
    trigger: str = "manual",
    entities: Optional[List[str]] = Query(default=None),
    run_config: Optional[Dict[str, Any]] = Body(default=None)
):
    """Trigger the integrity runner (runs in background).

    Args:
        request: FastAPI request object (injected)
        trigger: Trigger source ("nightly", "weekly", "schedule", or "manual")
        entities: Optional list of entity names to scan (deprecated, use run_config.entities)
        run_config: Optional run configuration with entities and rules

    Returns:
        - 200: Success with run_id (scan runs in background)
        - 500: Complete system failure (unable to start run)
    """
    # Get request ID from middleware
    request_id = getattr(request.state, "request_id", "unknown")
    
    # Merge entities from query param and run_config (run_config takes precedence)
    final_entities = None
    if run_config and run_config.get("entities"):
        final_entities = run_config["entities"]
    elif entities:
        final_entities = entities

    # DEBUG LOGGING: Show what was received from frontend
    logger.info("=" * 80)
    logger.info("API ENDPOINT: Received Scan Request")
    logger.info("=" * 80)
    logger.info(f"Trigger: {trigger}")
    logger.info(f"Entities (query param): {entities}")
    logger.info(f"Run config received: {run_config}")
    if run_config:
        logger.info(f"Run config entities: {run_config.get('entities')}")
        logger.info(f"Run config rules: {run_config.get('rules')}")
        logger.info(f"Run config checks: {run_config.get('checks')}")
    logger.info("=" * 80)

    logger.info(
        "Integrity run requested",
        extra={
            "trigger": trigger,
            "entities": final_entities,
            "has_run_config": run_config is not None,
            "has_rules": run_config is not None and "rules" in run_config if run_config else False,
            "request_id": request_id,
            "run_config_full": run_config
        }
    )

    try:
        # Generate run_id first
        import uuid
        run_id = str(uuid.uuid4())
        
        # Create cancellation event for this run
        cancel_event = threading.Event()
        
        # Store in running scans
        with running_scans_lock:
            running_scans[run_id] = cancel_event
        
        # Start background thread
        thread = threading.Thread(
            target=_run_integrity_background,
            args=(run_id, trigger, cancel_event, final_entities, run_config),
            daemon=True,
        )
        thread.start()
        
        logger.info("Integrity run started in background", extra={"run_id": run_id, "request_id": request_id})
        
        # Return immediately with run_id
        return {
            "run_id": run_id,
            "status": "running",
            "message": "Scan started in background",
        }
        
    except Exception as exc:
        logger.error(
            "Failed to start integrity run",
            extra={"error": str(exc), "request_id": request_id},
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"error": "Failed to start integrity run", "message": str(exc)},
        )


@app.post("/integrity/run/{run_id}/cancel", dependencies=[Depends(verify_cloud_scheduler_auth)])
def cancel_integrity_run(run_id: str, request: Request):
    """Cancel a running integrity scan.
    
    Args:
        run_id: Run identifier to cancel
        request: FastAPI request object (injected)
    
    Returns:
        - 200: Success (run cancelled or not found)
        - 404: Run not found or already completed
    """
    request_id = getattr(request.state, "request_id", "unknown")
    logger.info("Integrity run cancellation requested", extra={"run_id": run_id, "request_id": request_id})
    
    # Try to cancel via in-memory event first (if run is in current process)
    with running_scans_lock:
        cancel_event = running_scans.get(run_id)
        if cancel_event:
            # Set cancellation event
            cancel_event.set()
            logger.info("Integrity run cancellation signal sent", extra={"run_id": run_id, "request_id": request_id})
    
    # Always update Firestore status (works even if run is in different process/server)
    try:
        from .clients.firestore import FirestoreClient
        from .config.config_loader import load_runtime_config
        from .writers.firestore_writer import FirestoreWriter
        
        config = load_runtime_config()
        firestore_client = FirestoreClient(config.firestore)
        
        # Check if run exists and is still running by querying Firestore directly
        client = firestore_client._get_client()
        doc_ref = client.collection(config.firestore.runs_collection).document(run_id)
        run_doc = doc_ref.get()
        
        if not run_doc.exists:
            logger.warning("Run not found in Firestore", extra={"run_id": run_id, "request_id": request_id})
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail={"error": "Run not found", "run_id": run_id},
            )
        
        run_data = run_doc.to_dict()
        
        # Check if run is already completed
        # Only check status, not ended_at, since ended_at might be set incorrectly
        # or in a race condition while status is still "running"
        run_status = run_data.get("status", "").lower()
        completed_statuses = ["success", "error", "warning", "cancelled", "canceled", "healthy"]
        if run_status in completed_statuses:
            logger.info("Run already completed, cannot cancel", extra={"run_id": run_id, "status": run_data.get("status"), "request_id": request_id})
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"error": "Run already completed", "message": f"Run has already completed with status: {run_data.get('status')}", "run_id": run_id, "status": run_data.get("status")},
            )
        
        # If status is missing or empty, treat as running (allow cancellation)
        # This handles edge cases where status wasn't set properly
        
        # Calculate duration from start time to now
        started_at = run_data.get("started_at")
        end_time = datetime.now(timezone.utc)
        
        duration_ms = 0
        if started_at:
            try:
                # Convert Firestore timestamp to datetime
                start_dt = None
                
                # Check if it's a Firestore Timestamp object
                if hasattr(started_at, 'timestamp'):
                    # Firestore Timestamp object - use timestamp() method
                    start_ts = started_at.timestamp()
                    end_ts = end_time.timestamp()
                    duration_ms = int((end_ts - start_ts) * 1000)
                elif isinstance(started_at, datetime):
                    # Already a datetime object
                    if started_at.tzinfo is None:
                        # Assume UTC if no timezone
                        start_dt = started_at.replace(tzinfo=timezone.utc)
                    else:
                        start_dt = started_at
                    duration_ms = int((end_time - start_dt).total_seconds() * 1000)
                else:
                    # Try other conversion methods
                    if hasattr(started_at, 'toDate'):
                        start_dt = started_at.toDate()
                        if start_dt.tzinfo is None:
                            start_dt = start_dt.replace(tzinfo=timezone.utc)
                        duration_ms = int((end_time - start_dt).total_seconds() * 1000)
                    else:
                        # Fallback: try to parse as string or use existing duration
                        logger.warning(
                            "Could not parse started_at timestamp",
                            extra={"run_id": run_id, "started_at_type": str(type(started_at)), "request_id": request_id},
                        )
                        duration_ms = run_data.get("duration_ms", 0)
                
                # Ensure duration is not negative (sanity check)
                if duration_ms < 0:
                    logger.warning(
                        "Calculated negative duration, using existing or 0",
                        extra={"run_id": run_id, "calculated_duration_ms": duration_ms, "request_id": request_id},
                    )
                    duration_ms = run_data.get("duration_ms", 0)
                    
            except Exception as exc:
                logger.warning(
                    "Failed to calculate duration on cancel",
                    extra={"run_id": run_id, "error": str(exc), "started_at_type": str(type(started_at)), "request_id": request_id},
                    exc_info=True,
                )
                # Try to get existing duration_ms if calculation failed
                duration_ms = run_data.get("duration_ms", 0)
        
        # Preserve existing timing breakdown metrics if they exist
        update_data = {
            "status": "cancelled",  # Use lowercase to match integrity runner
            "ended_at": end_time,
            "cancelled_at": end_time,  # Separate field for cancellation time
            "duration_ms": duration_ms,
        }
        
        # Explicitly preserve started_at if it exists (don't overwrite it)
        if "started_at" in run_data:
            update_data["started_at"] = run_data["started_at"]
        
        # Preserve timing breakdown if it exists
        if "duration_fetch" in run_data:
            update_data["duration_fetch"] = run_data["duration_fetch"]
        if "duration_checks" in run_data:
            update_data["duration_checks"] = run_data["duration_checks"]
        if "duration_write_firestore" in run_data:
            update_data["duration_write_firestore"] = run_data["duration_write_firestore"]
        if "duration_write_issues_firestore" in run_data:
            update_data["duration_write_issues_firestore"] = run_data["duration_write_issues_firestore"]
        
        # Update run status to Canceled with duration
        firestore_client.record_run(run_id, update_data)
        
        # Log cancellation
        writer = FirestoreWriter(firestore_client)
        writer.write_log(run_id, "info", "Scan cancelled by user")
        
        logger.info("Run cancelled successfully", extra={"run_id": run_id, "request_id": request_id})
        return {"status": "success", "message": "Run cancellation requested", "run_id": run_id}
        
    except HTTPException:
        raise
    except Exception as exc:
        logger.error(
            "Failed to cancel run",
            extra={"run_id": run_id, "error": str(exc), "request_id": request_id},
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"error": "Failed to cancel run", "message": str(exc)},
        )


@app.delete("/integrity/run/{run_id}", dependencies=[Depends(verify_cloud_scheduler_auth)])
def delete_integrity_run(run_id: str, request: Request):
    """Delete an integrity run and all its associated logs.
    
    Args:
        run_id: Run identifier to delete
        request: FastAPI request object (injected)
    
    Returns:
        - 200: Success (run deleted)
        - 404: Run not found
    """
    request_id = getattr(request.state, "request_id", "unknown")
    logger.info("Integrity run deletion requested", extra={"run_id": run_id, "request_id": request_id})
    
    try:
        from .clients.firestore import FirestoreClient
        from .config.config_loader import load_runtime_config
        
        config = load_runtime_config()
        firestore_client = FirestoreClient(config.firestore)
        firestore_client.delete_run(run_id)
        
        logger.info("Integrity run deleted", extra={"run_id": run_id, "request_id": request_id})
        return {"status": "success", "message": "Run deleted successfully", "run_id": run_id}
    except Exception as exc:
        logger.error(
            "Failed to delete integrity run",
            extra={"run_id": run_id, "error": str(exc), "request_id": request_id},
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"error": "Failed to delete run", "message": str(exc), "run_id": run_id},
        )


@app.post("/integrity/runs/cancel-all", dependencies=[Depends(verify_cloud_scheduler_auth)])
def cancel_all_running_runs(request: Request):
    """Cancel all currently running integrity runs.
    
    Returns:
        - 200: Success with count of cancelled runs
    """
    request_id = getattr(request.state, "request_id", "unknown")
    logger.info("Cancel all running runs requested", extra={"request_id": request_id})
    
    try:
        from .clients.firestore import FirestoreClient
        from .config.config_loader import load_runtime_config
        from .writers.firestore_writer import FirestoreWriter
        
        config = load_runtime_config()
        firestore_client = FirestoreClient(config.firestore)
        client = firestore_client._get_client()
        collection_ref = client.collection(config.firestore.runs_collection)
        
        # Query for all runs with status "running" or missing status (treat as running)
        running_runs_query = collection_ref.where("status", "==", "running")
        running_runs = list(running_runs_query.stream())
        
        # Also check for runs without status field (might be running)
        all_runs_query = collection_ref.stream()
        runs_without_status = [
            doc for doc in all_runs_query 
            if not doc.to_dict().get("status") or doc.to_dict().get("status", "").strip() == ""
        ]
        
        # Combine and deduplicate
        all_running_run_ids = set()
        for doc in running_runs:
            all_running_run_ids.add(doc.id)
        for doc in runs_without_status:
            all_running_run_ids.add(doc.id)
        
        cancelled_count = 0
        errors = []
        
        # Cancel each running run
        for run_id in all_running_run_ids:
            try:
                # Try to cancel via in-memory event first
                with running_scans_lock:
                    cancel_event = running_scans.get(run_id)
                    if cancel_event:
                        cancel_event.set()
                        logger.info("Cancellation signal sent to running scan", extra={"run_id": run_id})
                
                # Update Firestore status
                doc_ref = collection_ref.document(run_id)
                run_doc = doc_ref.get()
                
                if not run_doc.exists:
                    continue
                
                run_data = run_doc.to_dict()
                run_status = run_data.get("status", "").lower()
                completed_statuses = ["success", "error", "warning", "cancelled", "canceled", "healthy"]
                
                if run_status in completed_statuses:
                    continue
                
                # Calculate duration
                started_at = run_data.get("started_at")
                end_time = datetime.now(timezone.utc)
                duration_ms = 0
                if started_at:
                    if hasattr(started_at, "timestamp"):
                        start_timestamp = started_at.timestamp()
                    else:
                        start_timestamp = started_at
                    end_timestamp = end_time.timestamp()
                    duration_ms = int((end_timestamp - start_timestamp) * 1000)
                
                # Update run status to cancelled
                update_data = {
                    "status": "cancelled",
                    "ended_at": end_time,
                    "duration_ms": duration_ms,
                }
                firestore_client.record_run(run_id, update_data)
                
                # Log cancellation
                writer = FirestoreWriter(firestore_client)
                writer.write_log(run_id, "info", "Scan cancelled by user (cancel all)")
                
                cancelled_count += 1
            except Exception as exc:
                errors.append({"run_id": run_id, "error": str(exc)})
                logger.error(
                    f"Failed to cancel run {run_id}",
                    extra={"run_id": run_id, "error": str(exc)},
                    exc_info=True,
                )
        
        logger.info(
            "Cancel all running runs completed",
            extra={"cancelled_count": cancelled_count, "errors": len(errors), "request_id": request_id},
        )
        
        return {
            "status": "success",
            "message": f"Cancelled {cancelled_count} running run(s)",
            "cancelled_count": cancelled_count,
            "errors": errors,
        }
        
    except Exception as exc:
        logger.error(
            "Failed to cancel all running runs",
            extra={"error": str(exc), "request_id": request_id},
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"error": "Failed to cancel all running runs", "message": str(exc)},
        )


@app.delete("/integrity/runs/all", dependencies=[Depends(verify_cloud_scheduler_auth)])
def delete_all_runs(request: Request):
    """Delete all integrity runs and their associated logs.
    
    Returns:
        - 200: Success with count of deleted runs
    """
    request_id = getattr(request.state, "request_id", "unknown")
    logger.info("Delete all runs requested", extra={"request_id": request_id})
    
    try:
        from .clients.firestore import FirestoreClient
        from .config.config_loader import load_runtime_config
        
        config = load_runtime_config()
        firestore_client = FirestoreClient(config.firestore)
        client = firestore_client._get_client()
        collection_ref = client.collection(config.firestore.runs_collection)
        
        # Get all runs
        all_runs = list(collection_ref.stream())
        deleted_count = 0
        errors = []
        
        # Delete each run
        for doc in all_runs:
            try:
                firestore_client.delete_run(doc.id)
                deleted_count += 1
            except Exception as exc:
                errors.append({"run_id": doc.id, "error": str(exc)})
                logger.error(
                    f"Failed to delete run {doc.id}",
                    extra={"run_id": doc.id, "error": str(exc)},
                    exc_info=True,
                )
        
        logger.info(
            "Delete all runs completed",
            extra={"deleted_count": deleted_count, "errors": len(errors), "request_id": request_id},
        )
        
        return {
            "status": "success",
            "message": f"Deleted {deleted_count} run(s)",
            "deleted_count": deleted_count,
            "errors": errors,
        }
        
    except Exception as exc:
        logger.error(
            "Failed to delete all runs",
            extra={"error": str(exc), "request_id": request_id},
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"error": "Failed to delete all runs", "message": str(exc)},
        )


@app.get("/airtable/schema", dependencies=[Depends(verify_firebase_token)])
def airtable_schema():
    """Return the full Airtable schema snapshot JSON (requires authentication)."""
    try:
        result = schema_service.load()
        return result
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        logger.error("Error loading schema", exc_info=True, extra={"error": str(exc)})
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(exc)}") from exc


@app.get("/airtable/schema/summary")
def airtable_schema_summary():
    """Return a compact rollup of Airtable tables, fields, and records (public endpoint)."""
    try:
        return schema_service.summary()
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.get("/airtable/schema/fields/{entity}", dependencies=[Depends(verify_firebase_token)])
def airtable_schema_fields(entity: str, search: Optional[str] = None):
    """Return fields for a specific entity/table, optionally filtered by search term.
    
    Args:
        entity: Entity name (e.g., "contractors", "students")
        search: Optional search term to filter fields by name (case-insensitive)
        
    Returns:
        Dictionary with:
            - entity: Entity name
            - table_name: Airtable table name
            - fields: List of field objects with id, name, type
            - count: Number of fields returned
    """
    try:
        from .utils.records import _normalize_name
        
        schema_data = schema_service.load()
        tables = schema_data.get("tables", [])
        
        # Map entity to table name
        entity_to_table = {
            "contractors": "Contractors/Volunteers",
            "students": "Students",
            "parents": "Parents",
            "classes": "Classes",
            "attendance": "Attendance",
            "truth": "Truth",
            "payments": "Contractor/Vendor Invoices",
        }
        
        table_name = entity_to_table.get(entity.lower(), entity.title())
        
        # Find the table
        target_table = None
        for table in tables:
            table_name_lower = table.get("name", "").lower()
            if (table.get("name") == table_name or 
                entity.lower() in table_name_lower or
                table_name_lower in entity.lower()):
                target_table = table
                break
        
        if not target_table:
            raise HTTPException(
                status_code=404,
                detail=f"Table not found for entity: {entity}"
            )
        
        # Get all fields
        all_fields = target_table.get("fields", [])
        
        # Filter by search term if provided
        if search:
            search_normalized = _normalize_name(search)
            filtered_fields = []
            for field in all_fields:
                field_name = field.get("name", "")
                if (search.lower() in field_name.lower() or
                    search_normalized in _normalize_name(field_name) or
                    search.lower() in field.get("id", "").lower()):
                    filtered_fields.append(field)
            fields = filtered_fields
        else:
            fields = all_fields
        
        # Format response
        formatted_fields = [
            {
                "id": field.get("id"),
                "name": field.get("name"),
                "type": field.get("type"),
            }
            for field in fields
        ]
        
        return {
            "entity": entity,
            "table_name": target_table.get("name"),
            "table_id": target_table.get("id"),
            "fields": formatted_fields,
            "count": len(formatted_fields),
        }
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("Error loading fields for entity", exc_info=True, extra={"entity": entity, "error": str(exc)})
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(exc)}") from exc


@app.post("/airtable/schema/discover-table-ids", dependencies=[Depends(verify_firebase_token)])
def discover_and_update_table_ids():
    """Discover table IDs from schema JSON and update configuration.
    
    This endpoint:
    1. Loads the schema JSON and entity-to-table mapping
    2. Discovers table IDs by matching table names
    3. Updates .env file and/or Firestore config with discovered IDs
    
    Returns:
        Dictionary with discovered IDs and update status
    """
    try:
        # Discover table IDs and base ID
        discovery_result = discover_table_ids()
        
        if not discovery_result or not discovery_result.get("table_ids"):
            return {
                "success": False,
                "message": "No table IDs discovered. Check schema file and mapping config.",
                "discovered": {},
                "updates": {},
            }
        
        table_ids = discovery_result.get("table_ids", {})
        base_id = discovery_result.get("base_id")
        entities = list(table_ids.keys())
        
        # Get Firestore client for config updates (if available)
        firestore_client = None
        try:
            from .clients.firestore import FirestoreClient
            from .config.settings import FirestoreConfig
            from .config.config_loader import load_runtime_config
            
            # Try to get Firestore client from runtime config
            temp_config = load_runtime_config()
            firestore_client = FirestoreClient(temp_config.firestore)
        except Exception as exc:
            logger.debug(f"Firestore client not available for config updates: {exc}")
        
        # Update configuration
        update_results = update_config(
            table_ids,
            base_id=base_id,
            entities=entities,
            firestore_client=firestore_client,
            use_firestore=firestore_client is not None,
        )
        
        # Validate results
        validation = validate_discovered_ids(table_ids)
        all_valid = all(validation.values())
        
        # Count successful updates
        env_updates = sum(1 for v in update_results.get("env", {}).values() if v)
        firestore_updates = sum(1 for v in update_results.get("firestore", {}).values() if v)
        
        message = f"Discovered base ID and {len(table_ids)} table IDs. Updated {env_updates} in .env, {firestore_updates} in Firestore."
        if base_id:
            message = f"Discovered base ID ({base_id}) and {len(table_ids)} table IDs. Updated {env_updates} in .env, {firestore_updates} in Firestore."
        
        return {
            "success": True,
            "message": message,
            "discovered": {
                "base_id": base_id,
                "table_ids": table_ids,
            },
            "validation": validation,
            "updates": update_results,
            "all_valid": all_valid,
        }
        
    except FileNotFoundError as exc:
        logger.error(f"Schema or mapping file not found: {exc}")
        raise HTTPException(
            status_code=404,
            detail=f"Schema or mapping file not found: {exc}"
        ) from exc
    except Exception as exc:
        logger.error(f"Failed to discover table IDs: {exc}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Failed to discover table IDs: {str(exc)}"
        ) from exc


@app.get("/airtable/records/{table_id}", dependencies=[Depends(verify_firebase_token)])
def airtable_records(table_id: str):
    """Fetch all records from a specific Airtable table for CSV export (requires authentication)."""
    try:
        schema_data = schema_service.load()
        base_id = schema_data.get("baseId")
        
        if not base_id:
            raise HTTPException(
                status_code=400,
                detail="Base ID not found in schema. Please regenerate the schema."
            )
        
        import os
        import time
        from pyairtable import Api
        from requests.exceptions import HTTPError, RequestException
        
        # Use Personal Access Token (PAT) for Airtable authentication
        pat = os.getenv("AIRTABLE_PAT")
        
        if not pat:
            raise HTTPException(
                status_code=500,
                detail="AIRTABLE_PAT environment variable must be set"
            )
        
        token = pat
        api = Api(token)
        table = api.table(base_id, table_id)
        
        logger.info(
            "Fetching Airtable records for download",
            extra={"base": base_id, "table": table_id},
        )
        
        records = list(table.all())
        
        logger.info(
            "Fetched Airtable records successfully",
            extra={"base": base_id, "table": table_id, "record_count": len(records)},
        )
        
        return {"records": records, "count": len(records)}
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except (HTTPError, RequestException) as exc:
        logger.error(
            "Airtable API error",
            extra={"table_id": table_id, "error": str(exc)},
            exc_info=True,
        )
        raise HTTPException(
            status_code=502,
            detail=f"Airtable API error: {str(exc)}"
        ) from exc
    except Exception as exc:
        logger.error(
            "Failed to fetch Airtable records",
            extra={"table_id": table_id, "error": str(exc)},
            exc_info=True,
        )
        raise HTTPException(
            status_code=500,
            detail=f"Failed to fetch records: {str(exc)}"
        ) from exc


@app.get("/integrity/metrics/summary")
def integrity_metrics_summary():
    """Return current issue counts by type and severity."""
    metrics_service = get_metrics_service()
    summary = metrics_service.get_issue_summary()
    latest_run = metrics_service.get_latest_run()
    
    response = {
        "summary": summary,
        "last_run": latest_run,
    }
    
    if latest_run:
        response["last_run_time"] = latest_run.get("started_at") or latest_run.get("ended_at")
        response["last_run_duration"] = latest_run.get("duration_ms")
    
    return response


@app.get("/integrity/metrics/runs")
def integrity_metrics_runs(limit: int = 10):
    """Return recent integrity run history."""
    metrics_service = get_metrics_service()
    runs = metrics_service.get_run_history(limit=limit)
    return {"runs": runs, "count": len(runs)}


@app.get("/integrity/metrics/trends")
def integrity_metrics_trends(days: int = 7):
    """Return daily metrics for trend charts."""
    metrics_service = get_metrics_service()
    trends = metrics_service.get_trend_data(days=days)
    return {"trends": trends, "days": days}


@app.get("/integrity/metrics/queues")
def integrity_metrics_queues():
    """Return issue queues grouped by category."""
    metrics_service = get_metrics_service()
    queues = metrics_service.get_issue_queues()
    return {"queues": queues, "count": len(queues)}


@app.get("/integrity/metrics/derived")
def integrity_metrics_derived():
    """Return derived metrics (completeness, link health, duplicate rate)."""
    metrics_service = get_metrics_service()
    derived = metrics_service.get_derived_metrics()
    return derived


@app.get("/integrity/metrics/flagged-rules")
def integrity_metrics_flagged_rules():
    """Return rules flagged for review due to high ignored percentage."""
    metrics_service = get_metrics_service()
    flagged_rules = metrics_service.get_flagged_rules()
    return {"flagged_rules": flagged_rules, "count": len(flagged_rules)}


@app.delete("/integrity/issue/{issue_id}", dependencies=[Depends(verify_firebase_token)])
def delete_integrity_issue(issue_id: str, request: Request):
    """Delete an integrity issue from Firestore.
    
    Args:
        issue_id: Issue identifier to delete
        request: FastAPI request object (injected)
    
    Returns:
        - 200: Success (issue deleted)
        - 404: Issue not found
        - 500: Server error
    """
    request_id = getattr(request.state, "request_id", "unknown")
    logger.info("Integrity issue deletion requested", extra={"issue_id": issue_id, "request_id": request_id})
    
    try:
        from .clients.firestore import FirestoreClient
        from .config.config_loader import load_runtime_config
        
        config = load_runtime_config()
        firestore_client = FirestoreClient(config.firestore)
        client = firestore_client._get_client()
        
        # Delete the issue document
        issue_ref = client.collection(config.firestore.issues_collection).document(issue_id)
        issue_doc = issue_ref.get()
        
        if not issue_doc.exists:
            logger.warning("Issue not found in Firestore", extra={"issue_id": issue_id, "request_id": request_id})
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail={"error": "Issue not found", "issue_id": issue_id},
            )
        
        issue_ref.delete()
        
        logger.info("Integrity issue deleted", extra={"issue_id": issue_id, "request_id": request_id})
        return {"status": "success", "message": "Issue deleted successfully", "issue_id": issue_id}
    except HTTPException:
        raise
    except Exception as exc:
        logger.error(
            "Failed to delete integrity issue",
            extra={"issue_id": issue_id, "error": str(exc), "request_id": request_id},
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"error": "Failed to delete issue", "message": str(exc), "issue_id": issue_id},
        )


@app.get("/integrity/issues/bulk/count", dependencies=[Depends(verify_firebase_token)])
def count_bulk_delete_issues(
    request: Request,
    date_range: str = Query(...),
    issue_types: Optional[List[str]] = Query(None),
    entities: Optional[List[str]] = Query(None),
    custom_start_date: Optional[str] = Query(None),
    custom_end_date: Optional[str] = Query(None),
):
    """Count issues that would be deleted by bulk delete operation.
    
    Uses the same filters as bulk_delete_issues to return the count.
    """
    request_id = getattr(request.state, "request_id", "unknown")
    
    try:
        from .clients.firestore import FirestoreClient
        from .config.config_loader import load_runtime_config
        from datetime import datetime, timedelta, timezone
        
        config = load_runtime_config()
        firestore_client = FirestoreClient(config.firestore)
        client = firestore_client._get_client()
        issues_ref = client.collection(config.firestore.issues_collection)
        
        # Build base query with date filter (same logic as bulk_delete)
        query = issues_ref
        
        if date_range == "all":
            pass
        elif date_range == "past_hour":
            cutoff = datetime.now(timezone.utc) - timedelta(hours=1)
            query = query.where("created_at", ">=", cutoff)
        elif date_range == "past_day":
            cutoff = datetime.now(timezone.utc) - timedelta(days=1)
            query = query.where("created_at", ">=", cutoff)
        elif date_range == "past_week":
            cutoff = datetime.now(timezone.utc) - timedelta(days=7)
            query = query.where("created_at", ">=", cutoff)
        elif date_range == "custom":
            if not custom_start_date or not custom_end_date:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail={"error": "custom_start_date and custom_end_date required for custom date range"},
                )
            try:
                start_date = datetime.fromisoformat(custom_start_date.replace("Z", "+00:00"))
                end_date = datetime.fromisoformat(custom_end_date.replace("Z", "+00:00"))
                query = query.where("created_at", ">=", start_date).where("created_at", "<=", end_date)
            except ValueError as e:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail={"error": f"Invalid date format: {str(e)}"},
                )
        else:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"error": f"Invalid date_range: {date_range}"},
            )
        
        # Count matching documents (client-side filtering for types/entities)
        all_docs = query.stream()
        count = 0
        has_type_filter = issue_types and len(issue_types) > 0
        has_entity_filter = entities and len(entities) > 0
        
        for doc in all_docs:
            data = doc.to_dict()
            matches = False
            
            if not has_type_filter and not has_entity_filter:
                matches = True
            else:
                if has_type_filter and data.get("issue_type") in issue_types:
                    matches = True
                if has_entity_filter and data.get("entity") in entities:
                    matches = True
            
            if matches:
                count += 1
        
        return {
            "status": "success",
            "count": count,
        }
    except HTTPException:
        raise
    except Exception as exc:
        logger.error(
            "Failed to count bulk delete issues",
            extra={"error": str(exc), "request_id": request_id},
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"error": "Failed to count issues", "message": str(exc)},
        )


@app.delete("/integrity/issues/bulk", dependencies=[Depends(verify_firebase_token)])
def bulk_delete_issues(
    request: Request,
    date_range: str = Query(...),  # past_hour, past_day, past_week, custom, all
    issue_types: Optional[List[str]] = Query(None),
    entities: Optional[List[str]] = Query(None),
    custom_start_date: Optional[str] = Query(None),
    custom_end_date: Optional[str] = Query(None),
):
    """Bulk delete integrity issues from Firestore based on filters.
    
    Args:
        issue_types: Optional list of issue types to filter by (e.g., ["duplicate", "missing_link"])
        entities: Optional list of entities to filter by (e.g., ["students", "contractors"])
        date_range: Date range filter (past_hour, past_day, past_week, custom, all)
        custom_start_date: Start date for custom range (ISO format, required if date_range=custom)
        custom_end_date: End date for custom range (ISO format, required if date_range=custom)
        request: FastAPI request object (injected)
    
    Returns:
        - 200: Success with deleted count
        - 400: Invalid parameters
        - 500: Server error
    """
    request_id = getattr(request.state, "request_id", "unknown")
    logger.info(
        "Bulk delete issues requested",
        extra={
            "issue_types": issue_types,
            "entities": entities,
            "date_range": date_range,
            "request_id": request_id,
        }
    )
    
    try:
        from .clients.firestore import FirestoreClient
        from .config.config_loader import load_runtime_config
        from datetime import datetime, timedelta, timezone
        
        config = load_runtime_config()
        firestore_client = FirestoreClient(config.firestore)
        client = firestore_client._get_client()
        issues_ref = client.collection(config.firestore.issues_collection)
        
        # Build base query with date filter
        query = issues_ref
        
        # Date range filter
        if date_range == "all":
            # No date filter - query all issues
            pass
        elif date_range == "past_hour":
            cutoff = datetime.now(timezone.utc) - timedelta(hours=1)
            query = query.where("created_at", ">=", cutoff)
        elif date_range == "past_day":
            cutoff = datetime.now(timezone.utc) - timedelta(days=1)
            query = query.where("created_at", ">=", cutoff)
        elif date_range == "past_week":
            cutoff = datetime.now(timezone.utc) - timedelta(days=7)
            query = query.where("created_at", ">=", cutoff)
        elif date_range == "custom":
            if not custom_start_date or not custom_end_date:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail={"error": "custom_start_date and custom_end_date required for custom date range"},
                )
            try:
                start_date = datetime.fromisoformat(custom_start_date.replace("Z", "+00:00"))
                end_date = datetime.fromisoformat(custom_end_date.replace("Z", "+00:00"))
                query = query.where("created_at", ">=", start_date).where("created_at", "<=", end_date)
            except ValueError as e:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail={"error": f"Invalid date format: {str(e)}"},
                )
        else:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"error": f"Invalid date_range: {date_range}"},
            )
        
        # Fetch all documents matching date filter, then filter client-side for types/entities (OR logic)
        # Firestore doesn't support OR queries natively across different fields
        all_docs = query.stream()
        
        deleted_count = 0
        batch = client.batch()
        batch_count = 0
        
        # Filter client-side for issue_types and entities (OR logic)
        # If no type/entity filters and date_range is "all", delete all documents
        has_type_filter = issue_types and len(issue_types) > 0
        has_entity_filter = entities and len(entities) > 0
        
        for doc in all_docs:
            data = doc.to_dict()
            matches = False
            
            # If no type/entity filters, match all (delete everything matching date filter)
            if not has_type_filter and not has_entity_filter:
                matches = True
            else:
                # OR logic: match if issue_type in selected types OR entity in selected entities
                if has_type_filter and data.get("issue_type") in issue_types:
                    matches = True
                if has_entity_filter and data.get("entity") in entities:
                    matches = True
            
            if matches:
                batch.delete(doc.reference)
                batch_count += 1
                deleted_count += 1
                
                # Firestore batch limit is 500 operations
                if batch_count >= 500:
                    batch.commit()
                    batch = client.batch()
                    batch_count = 0
        
        # Commit remaining deletions
        if batch_count > 0:
            batch.commit()
        
        logger.info(
            "Bulk delete completed",
            extra={
                "deleted_count": deleted_count,
                "filters": {
                    "issue_types": issue_types,
                    "entities": entities,
                    "date_range": date_range,
                },
                "request_id": request_id,
            }
        )
        
        return {
            "status": "success",
            "message": f"Deleted {deleted_count} issues",
            "deleted_count": deleted_count,
        }
    except HTTPException:
        raise
    except Exception as exc:
        logger.error(
            "Failed to bulk delete issues",
            extra={"error": str(exc), "request_id": request_id},
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"error": "Failed to bulk delete issues", "message": str(exc)},
        )


@app.get("/integrity/metrics/kpi")
def integrity_metrics_kpi(weeks: int = 8):
    """Return KPI measurement data and trend.

    Args:
        weeks: Number of weeks of history to return (default 8)

    Returns:
        Dictionary with latest KPI, trend data, and alerts
    """
    from .services.kpi_sampler import get_kpi_sampler

    sampler = get_kpi_sampler()
    # Use public method instead of accessing private internals
    samples = sampler.get_recent_kpi_samples(limit=weeks)
    
    # Get latest sample
    latest = samples[0] if samples else None
    
    # Build trend
    trend = []
    for sample in reversed(samples):
        if "kpi_percent" in sample:
            trend.append({
                "week_id": sample.get("week_id", ""),
                "kpi_percent": sample.get("kpi_percent", 0),
                "measured_at": sample.get("measured_at"),
            })
    
    # Check for alerts
    alerts = []
    if latest:
        if latest.get("kpi_percent", 100) < 90:
            alerts.append({
                "type": "kpi_below_target",
                "message": f"KPI at {latest.get('kpi_percent', 0)}% (target: 90%)",
                "severity": "warning",
            })
        if latest.get("false_negatives", 0) > 10:
            alerts.append({
                "type": "high_false_negatives",
                "message": f"{latest.get('false_negatives', 0)} false negatives detected",
                "severity": "info",
            })
    
    return {
        "latest": latest,
        "trend": trend,
        "alerts": alerts,
        "target": 90.0,
    }


@app.post("/integrity/kpi/sample", dependencies=[Depends(verify_cloud_scheduler_auth)])
def integrity_kpi_sample():
    """Trigger weekly KPI sampling (called by scheduler or authenticated requests).

    This endpoint generates a sample but does not calculate KPI until reviewer labels are provided.
    """
    from ..services.kpi_sampler import get_kpi_sampler
    from ..services.integrity_runner import IntegrityRunner
    
    try:
        # Fetch current records for sampling
        runner = IntegrityRunner()
        records, _ = runner._fetch_records("full")
        
        # Generate sample
        sampler = get_kpi_sampler()
        sample_data = sampler.generate_weekly_sample(records)
        
        # Store sample
        sampler._firestore_client.record_kpi_sample(sample_data["week_id"], sample_data)
        
        return {
            "status": "success",
            "week_id": sample_data["week_id"],
            "sample_size": sample_data["sample_size"],
            "message": "KPI sample generated. Awaiting reviewer labels.",
        }
    except Exception as exc:
        logger.error(
            "KPI sampling failed",
            extra={"error": str(exc)},
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"error": "KPI sampling failed", "message": str(exc)},
        )


class RecordsByIdsRequest(BaseModel):
    """Request body for fetching records by IDs."""
    entity: str
    record_ids: List[str]


@app.post("/airtable/records/by-ids", dependencies=[Depends(verify_firebase_token)])
def get_airtable_records_by_ids(request: Request, body: RecordsByIdsRequest):
    """Fetch specific Airtable records by their IDs.

    Args:
        request: FastAPI request object (injected)
        body: Request body with entity and record_ids

    Returns:
        Dictionary with records data keyed by record ID
    """
    entity = body.entity
    record_ids = body.record_ids
    request_id = getattr(request.state, "request_id", "unknown")
    logger.info(
        "Fetching Airtable records by IDs",
        extra={"entity": entity, "record_count": len(record_ids), "request_id": request_id},
    )

    if not record_ids:
        return {"records": {}, "count": 0}

    # Limit to prevent abuse
    if len(record_ids) > 50:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot fetch more than 50 records at once"
        )

    try:
        import os
        from pyairtable import Api
        from pyairtable.formulas import RECORD_ID, OR

        # Load schema to get table ID from entity name
        schema_data = schema_service.load()
        base_id = schema_data.get("baseId")

        if not base_id:
            raise HTTPException(
                status_code=400,
                detail="Base ID not found in schema. Please regenerate the schema."
            )

        # Find table by entity name
        entity_lower = entity.lower().strip()
        # Map singular to plural
        entity_mapping = {
            "student": "students",
            "parent": "parents",
            "contractor": "contractors",
            "class": "classes",
        }
        normalized_entity = entity_mapping.get(entity_lower, entity_lower)

        table_id = None
        for table in schema_data.get("tables", []):
            table_name_lower = table.get("name", "").lower().strip()
            if (table_name_lower == normalized_entity or
                table_name_lower == entity_lower or
                normalized_entity in table_name_lower):
                table_id = table.get("id")
                break

        if not table_id:
            # Try environment variable fallback
            env_key = f"AIRTABLE_{normalized_entity.upper()}_TABLE"
            table_id = os.getenv(env_key)

        if not table_id:
            logger.warning(
                "Table not found for entity",
                extra={"entity": entity, "normalized": normalized_entity, "request_id": request_id},
            )
            return {"records": {}, "count": 0, "error": f"Table not found for entity: {entity}"}

        # Get Airtable API client using Personal Access Token (PAT)
        pat = os.getenv("AIRTABLE_PAT")

        if not pat:
            raise HTTPException(
                status_code=500,
                detail="AIRTABLE_PAT environment variable must be set"
            )

        token = pat
        api = Api(token)
        table = api.table(base_id, table_id)

        # Build formula to fetch records by IDs
        # RECORD_ID() = 'recXXX' OR RECORD_ID() = 'recYYY' ...
        record_conditions = [f"RECORD_ID()='{rid}'" for rid in record_ids]
        formula = f"OR({','.join(record_conditions)})"

        logger.debug(
            "Fetching records with formula",
            extra={"formula": formula[:200], "request_id": request_id},
        )

        # Fetch records
        fetched = list(table.all(formula=formula))

        # Build response keyed by record ID
        records_by_id = {}
        for record in fetched:
            rid = record.get("id")
            fields = record.get("fields", {})
            records_by_id[rid] = {
                "id": rid,
                "fields": fields,
                "createdTime": record.get("createdTime"),
            }

        logger.info(
            "Successfully fetched Airtable records",
            extra={
                "entity": entity,
                "requested": len(record_ids),
                "fetched": len(records_by_id),
                "request_id": request_id,
            },
        )

        return {"records": records_by_id, "count": len(records_by_id)}

    except HTTPException:
        raise
    except Exception as exc:
        logger.error(
            "Failed to fetch Airtable records by IDs",
            extra={"entity": entity, "error": str(exc), "request_id": request_id},
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"error": "Failed to fetch records", "message": str(exc)},
        )


# Rules Management API Endpoints

@app.get("/rules", dependencies=[Depends(verify_firebase_token)])
def get_all_rules(request: Request):
    """Get all rules merged from YAML and Firestore."""
    request_id = getattr(request.state, "request_id", None)
    try:
        firestore_client = None
        if runner:
            firestore_client = runner._firestore_client
        
        rules_service = RulesService(firestore_client)
        rules = rules_service.get_all_rules()
        
        logger.info(
            "Retrieved all rules",
            extra={"request_id": request_id},
        )
        
        return rules
    except Exception as exc:
        logger.error(
            "Failed to get rules",
            extra={"error": str(exc), "request_id": request_id},
            exc_info=True,
        )
        # Return empty structure instead of raising to prevent frontend hang
        return {
            "duplicates": {},
            "relationships": {},
            "required_fields": {},
            "attendance_rules": {
                "onboarding_grace_days": 7,
                "limited_schedule_threshold": 3,
                "thresholds": {},
            },
        }


@app.get("/rules/{category}", dependencies=[Depends(verify_firebase_token)])
def get_rules_by_category(category: str, request: Request):
    """Get rules for a specific category."""
    try:
        request_id = getattr(request.state, "request_id", None)
        
        valid_categories = ["duplicates", "relationships", "required_fields", "attendance_rules"]
        if category not in valid_categories:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid category. Must be one of: {', '.join(valid_categories)}",
            )
        
        firestore_client = None
        if runner:
            firestore_client = runner._firestore_client
        
        rules_service = RulesService(firestore_client)
        rules = rules_service.get_rules_by_category(category)
        
        logger.info(
            "Retrieved rules by category",
            extra={"category": category, "request_id": request_id},
        )
        
        return rules
    except HTTPException:
        raise
    except Exception as exc:
        logger.error(
            "Failed to get rules by category",
            extra={"category": category, "error": str(exc), "request_id": getattr(request.state, "request_id", None)},
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"error": "Failed to get rules", "message": str(exc)},
        )

class ParseRuleRequest(BaseModel):
    """Request body for parsing a rule with AI."""
    description: str
    category_hint: Optional[str] = None


@app.post("/rules/ai-parse")
def parse_rule_with_ai(
    body: ParseRuleRequest,
    request: Request,
    user: dict = Depends(verify_firebase_token),
):
    """Parse natural language rule description into structured format."""
    try:
        request_id = getattr(request.state, "request_id", None)

        logger.info(
            "AI parse request received",
            extra={
                "description_length": len(body.description) if body.description else 0,
                "has_category_hint": body.category_hint is not None,
                "request_id": request_id,
            },
        )

        parser = AIRuleParser()
        result = parser.parse(body.description, body.category_hint)

        logger.info(
            "Parsed rule with AI",
            extra={"category": result.get("category"), "request_id": request_id},
        )

        return result
    except HTTPException:
        raise
    except Exception as exc:
        logger.error(
            "Failed to parse rule with AI",
            extra={"error": str(exc), "request_id": getattr(request.state, "request_id", None)},
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"error": "Failed to parse rule", "message": str(exc)},
        )

class CreateRuleRequest(BaseModel):
    """Request body for creating a rule."""
    entity: Optional[str] = None
    rule_data: dict


@app.post("/rules/{category}", dependencies=[Depends(verify_firebase_token)])
def create_rule(
    category: str,
    request: Request,
    body: CreateRuleRequest,
):
    """Create a new rule in the specified category."""
    try:
        request_id = getattr(request.state, "request_id", None)
        
        valid_categories = ["duplicates", "relationships", "required_fields", "attendance_rules"]
        if category not in valid_categories:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid category. Must be one of: {', '.join(valid_categories)}",
            )
        
        # Get user ID from token if available
        user_id = None
        # TODO: Extract user_id from Firebase token if needed
        
        firestore_client = None
        if runner:
            firestore_client = runner._firestore_client
        
        rules_service = RulesService(firestore_client)
        created_rule = rules_service.create_rule(category, body.entity, body.rule_data, user_id)
        
        logger.info(
            "Created rule",
            extra={"category": category, "entity": body.entity, "request_id": request_id},
        )
        
        return {"success": True, "rule": created_rule}
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        logger.error(
            "Failed to create rule",
            extra={"category": category, "error": str(exc), "request_id": getattr(request.state, "request_id", None)},
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"error": "Failed to create rule", "message": str(exc)},
        )


class UpdateRuleRequest(BaseModel):
    """Request body for updating a rule."""
    entity: Optional[str] = None
    rule_data: dict


@app.put("/rules/{category}/{rule_id}", dependencies=[Depends(verify_firebase_token)])
def update_rule(
    category: str,
    rule_id: str,
    request: Request,
    body: UpdateRuleRequest,
):
    """Update an existing rule."""
    try:
        request_id = getattr(request.state, "request_id", None)
        
        valid_categories = ["duplicates", "relationships", "required_fields", "attendance_rules"]
        if category not in valid_categories:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid category. Must be one of: {', '.join(valid_categories)}",
            )
        
        user_id = None
        
        firestore_client = None
        if runner:
            firestore_client = runner._firestore_client
        
        rules_service = RulesService(firestore_client)
        updated_rule = rules_service.update_rule(category, body.entity, rule_id, body.rule_data, user_id)
        
        logger.info(
            "Updated rule",
            extra={"category": category, "rule_id": rule_id, "request_id": request_id},
        )
        
        return {"success": True, "rule": updated_rule}
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        logger.error(
            "Failed to update rule",
            extra={"category": category, "rule_id": rule_id, "error": str(exc), "request_id": getattr(request.state, "request_id", None)},
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"error": "Failed to update rule", "message": str(exc)},
        )


@app.delete("/rules/{category}/{rule_id}", dependencies=[Depends(verify_firebase_token)])
def delete_rule(
    category: str,
    rule_id: str,
    request: Request,
    entity: Optional[str] = Query(None),
):
    """Delete a rule."""
    try:
        request_id = getattr(request.state, "request_id", None)
        
        valid_categories = ["duplicates", "relationships", "required_fields", "attendance_rules"]
        if category not in valid_categories:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid category. Must be one of: {', '.join(valid_categories)}",
            )
        
        user_id = None
        
        firestore_client = None
        if runner:
            firestore_client = runner._firestore_client
        
        rules_service = RulesService(firestore_client)
        rules_service.delete_rule(category, entity, rule_id, user_id)
        
        logger.info(
            "Deleted rule",
            extra={"category": category, "rule_id": rule_id, "request_id": request_id},
        )
        
        return {"success": True, "message": f"Rule {rule_id} deleted"}
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        logger.error(
            "Failed to delete rule",
            extra={"category": category, "rule_id": rule_id, "error": str(exc), "request_id": getattr(request.state, "request_id", None)},
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"error": "Failed to delete rule", "message": str(exc)},
        )


