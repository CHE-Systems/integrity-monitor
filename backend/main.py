import logging
import os
import json
import time
import threading
import uuid
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
from .middleware.auth import verify_api_key_or_bearer_token, verify_bearer_token, verify_cloud_scheduler_auth, verify_firebase_token
from .services.integrity_runner import IntegrityRunner

from .services.airtable_schema_service import schema_service
from .services.integrity_metrics_service import get_metrics_service
from .services.table_id_discovery import discover_table_ids, validate_discovered_ids
from .services.config_updater import update_config
from .services.rules_service import RulesService
from .services.ai_rule_parser import AIRuleParser
from .services.issue_chat_service import IssueChatService
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
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
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


@app.get("/schema", dependencies=[Depends(verify_api_key_or_bearer_token)])
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
    thread_runner = None
    try:
        # Create a new runner instance for this thread
        if runner is None:
            logger.error("IntegrityRunner not available - cannot start scan", extra={"run_id": run_id})
            # Try to create runner anyway for error handling
            try:
                thread_runner = IntegrityRunner()
            except Exception:
                pass
            if thread_runner is None:
                return
        else:
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
        # Write error status to Firestore so UI can show the failure
        if thread_runner is not None:
            try:
                error_metadata = {
                    "status": "error",
                    "ended_at": datetime.now(timezone.utc),
                    "error_message": str(exc),
                }
                thread_runner._firestore_writer.write_run(run_id, {}, error_metadata)
            except Exception as firestore_exc:
                logger.warning(
                    "Failed to write error status to Firestore",
                    extra={"run_id": run_id, "error": str(firestore_exc)},
                )
    finally:
        # Clean up running scan tracking
        with running_scans_lock:
            running_scans.pop(run_id, None)


@app.post("/integrity/run", dependencies=[Depends(verify_cloud_scheduler_auth)])
async def run_integrity(
    request: Request,
    trigger: str = "manual",
    entities: Optional[List[str]] = Query(default=None),
):
    """Trigger the integrity runner (runs in background).

    Args:
        request: FastAPI request object (injected)
        trigger: Trigger source ("nightly", "weekly", "schedule", or "manual")
        entities: Optional list of entity names to scan (deprecated, use run_config.entities)

    Returns:
        - 200: Success with run_id (scan runs in background)
        - 500: Complete system failure (unable to start run)
    """
    # Read request body directly instead of using Body() parameter
    # This ensures the body is received correctly from Firebase Functions
    run_config: Optional[Dict[str, Any]] = None
    try:
        body_bytes = await request.body()
        if body_bytes:
            run_config = json.loads(body_bytes.decode('utf-8'))
    except Exception:
        pass
    
    # Get request ID from middleware
    request_id = getattr(request.state, "request_id", "unknown")
    
    # Merge entities from query param and run_config (run_config takes precedence)
    final_entities = None
    if run_config and run_config.get("entities"):
        final_entities = run_config["entities"]
    elif entities:
        final_entities = entities

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


@app.delete("/integrity/run/{run_id}", dependencies=[Depends(verify_firebase_token)])
def delete_integrity_run(
    run_id: str,
    request: Request,
    delete_issues: bool = Query(False, description="Also delete all issues found in this run"),
):
    """Delete an integrity run and all its associated logs.
    
    Args:
        run_id: Run identifier to delete
        request: FastAPI request object (injected)
        delete_issues: If True, also delete all issues associated with this run (where issue.run_id == run_id)
    
    Returns:
        - 200: Success (run deleted, optionally with issues deleted)
        - 404: Run not found
    """
    request_id = getattr(request.state, "request_id", "unknown")
    logger.info(
        "Integrity run deletion requested",
        extra={"run_id": run_id, "delete_issues": delete_issues, "request_id": request_id}
    )
    
    try:
        from .clients.firestore import FirestoreClient
        from .config.config_loader import load_runtime_config
        
        config = load_runtime_config()
        firestore_client = FirestoreClient(config.firestore)
        
        deleted_issues_count = 0
        
        # Delete issues first if requested
        if delete_issues:
            try:
                deleted_issues_count = firestore_client.delete_issues_for_run(run_id)
                logger.info(
                    "Deleted issues for run",
                    extra={"run_id": run_id, "deleted_issues_count": deleted_issues_count, "request_id": request_id}
                )
            except Exception as exc:
                logger.error(
                    "Failed to delete issues for run",
                    extra={"run_id": run_id, "error": str(exc), "request_id": request_id},
                    exc_info=True,
                )
                # Continue to delete run even if issue deletion fails
                # This ensures the run is still deleted if issue deletion has issues
        
        # Delete the run and its logs
        firestore_client.delete_run(run_id)
        
        logger.info(
            "Integrity run deleted",
            extra={
                "run_id": run_id,
                "deleted_issues_count": deleted_issues_count,
                "request_id": request_id
            }
        )
        
        response = {
            "status": "success",
            "message": "Run deleted successfully",
            "run_id": run_id,
        }
        
        if delete_issues:
            response["deleted_issues_count"] = deleted_issues_count
            response["message"] = f"Run and {deleted_issues_count} associated issues deleted successfully"
        
        return response
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


@app.get("/integrity/run/{run_id}/record-ids", dependencies=[Depends(verify_api_key_or_bearer_token)])
def get_run_record_ids(run_id: str, request: Request):
    """Return Airtable record IDs from a specific run, grouped by entity with issue context.

    Queries all issues for the given run_id and aggregates them by entity and record_id.
    Each record includes all its associated issues with type, severity, and rule info.

    Returns:
        - 200: Record IDs grouped by entity with issue context
        - 404: No issues found for run_id
    """
    request_id = getattr(request.state, "request_id", "unknown")
    logger.info(
        "Record IDs requested for run",
        extra={"run_id": run_id, "request_id": request_id},
    )

    try:
        from collections import defaultdict
        from .clients.firestore import FirestoreClient
        from .config.config_loader import load_runtime_config

        config = load_runtime_config()
        firestore_client = FirestoreClient(config.firestore)
        client = firestore_client._get_client()
        issues_ref = client.collection(config.firestore.issues_collection)

        query = issues_ref.where("run_id", "==", run_id)

        grouped = defaultdict(lambda: defaultdict(list))
        issue_count = 0

        for doc in query.stream():
            data = doc.to_dict()
            entity = data.get("entity", "unknown")
            record_id = data.get("record_id")
            if not record_id:
                continue

            issue_info = {
                "issue_type": data.get("issue_type"),
                "severity": data.get("severity"),
                "rule_id": data.get("rule_id"),
            }
            if data.get("description"):
                issue_info["description"] = data["description"]
            if data.get("related_records"):
                issue_info["related_records"] = data["related_records"]

            grouped[entity][record_id].append(issue_info)
            issue_count += 1

        if issue_count == 0:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail={"error": "No issues found for run", "run_id": run_id},
            )

        entities_response = {}
        total_records = 0

        for entity, records in sorted(grouped.items()):
            records_list = [
                {"record_id": rid, "issues": issues}
                for rid, issues in sorted(records.items())
            ]
            entities_response[entity] = {
                "records": records_list,
                "count": len(records_list),
            }
            total_records += len(records_list)

        logger.info(
            "Record IDs retrieved for run",
            extra={
                "run_id": run_id,
                "total_records": total_records,
                "total_issues": issue_count,
                "entities": list(entities_response.keys()),
                "request_id": request_id,
            },
        )

        return {
            "run_id": run_id,
            "entities": entities_response,
            "total_records": total_records,
            "total_issues": issue_count,
        }
    except HTTPException:
        raise
    except Exception as exc:
        logger.error(
            "Failed to get record IDs for run",
            extra={"run_id": run_id, "error": str(exc), "request_id": request_id},
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"error": "Failed to get record IDs", "message": str(exc), "run_id": run_id},
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
        from backend.utils.secrets import get_secret
        
        # Use Personal Access Token (PAT) for Airtable authentication
        # Try environment variable first, then Secret Manager for local development
        pat = get_secret("AIRTABLE_PAT")
        
        if not pat:
            raise HTTPException(
                status_code=500,
                detail="AIRTABLE_PAT not found in environment variables or Secret Manager. "
                       "Set AIRTABLE_PAT environment variable or ensure it exists in Google Cloud Secret Manager."
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


class ResolveIssuesRequest(BaseModel):
    record_ids: List[str]
    entity: str
    rule_ids: Optional[List[str]] = None


@app.post("/integrity/issues/resolve", dependencies=[Depends(verify_firebase_token)])
def resolve_issues_for_records(
    body: ResolveIssuesRequest,
    request: Request,
    user: dict = Depends(verify_firebase_token),
):
    """Delete all issues associated with given record IDs and entity.

    Used after remediation (edit, merge, delete) to mark issues as resolved.
    Optionally filter by specific rule_ids.

    Returns:
        - 200: { resolved_count, errors }
    """
    request_id = getattr(request.state, "request_id", "unknown")
    uid = user.get("uid", "unknown")
    logger.info(
        "Resolve issues requested",
        extra={
            "record_ids": body.record_ids,
            "entity": body.entity,
            "rule_ids": body.rule_ids,
            "user_uid": uid,
            "request_id": request_id,
        },
    )

    try:
        from .clients.firestore import FirestoreClient
        from .config.config_loader import load_runtime_config

        config = load_runtime_config()
        firestore_client = FirestoreClient(config.firestore)
        client = firestore_client._get_client()
        issues_ref = client.collection(config.firestore.issues_collection)

        resolved_count = 0
        errors = []

        for record_id in body.record_ids:
            try:
                query = issues_ref.where("record_id", "==", record_id).where(
                    "entity", "==", body.entity
                )
                if body.rule_ids:
                    query = query.where("rule_id", "in", body.rule_ids)

                for doc in query.stream():
                    doc.reference.delete()
                    resolved_count += 1
            except Exception as exc:
                errors.append({"record_id": record_id, "error": str(exc)})

        logger.info(
            "Issues resolved",
            extra={
                "resolved_count": resolved_count,
                "errors_count": len(errors),
                "user_uid": uid,
                "request_id": request_id,
            },
        )

        return {"resolved_count": resolved_count, "errors": errors}
    except Exception as exc:
        logger.error(
            "Failed to resolve issues",
            extra={"error": str(exc), "request_id": request_id},
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"error": "Failed to resolve issues", "message": str(exc)},
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


def _resolve_entity_to_table(entity: str) -> tuple:
    """Resolve entity name to (base_id, table_id).

    Handles singular/plural normalization and searches the schema tables.
    Falls back to environment variables if schema lookup fails.

    Returns:
        tuple of (base_id, table_id)

    Raises:
        HTTPException(400) if base ID not found in schema
        HTTPException(404) if table not found for entity
    """
    schema_data = schema_service.load()
    base_id = schema_data.get("baseId")
    if not base_id:
        raise HTTPException(
            status_code=400,
            detail="Base ID not found in schema. Please regenerate the schema.",
        )

    entity_lower = entity.lower().strip()
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
        table_name_normalized = table_name_lower.replace(" ", "_")
        entity_as_spaces = normalized_entity.replace("_", " ")
        if (
            table_name_lower == normalized_entity
            or table_name_lower == entity_lower
            or table_name_lower == entity_as_spaces
            or table_name_normalized == normalized_entity
            or normalized_entity in table_name_lower
            or entity_as_spaces in table_name_lower
        ):
            table_id = table.get("id")
            break

    if not table_id:
        env_key_airtable = f"AIRTABLE_{normalized_entity.upper()}_TABLE"
        env_key_at = f"AT_{normalized_entity.upper()}_TABLE"
        table_id = os.getenv(env_key_airtable) or os.getenv(env_key_at)

    if not table_id:
        raise HTTPException(
            status_code=404,
            detail=f"Table not found for entity: {entity}",
        )

    return base_id, table_id


def _get_airtable_table(base_id: str, table_id: str):
    """Get a pyairtable Table object with PAT auth.

    Returns:
        pyairtable Table instance

    Raises:
        HTTPException(500) if AIRTABLE_PAT is not configured
    """
    from pyairtable import Api
    from backend.utils.secrets import get_secret

    pat = get_secret("AIRTABLE_PAT")
    if not pat:
        raise HTTPException(
            status_code=500,
            detail="AIRTABLE_PAT not found in environment variables or Secret Manager.",
        )
    api = Api(pat)
    return api.table(base_id, table_id)


# Airtable field types that are computed and cannot accept writes
_COMPUTED_FIELD_TYPES = frozenset([
    "formula",
    "rollup",
    "lookup",
    "count",
    "autoNumber",
    "createdTime",
    "lastModifiedTime",
    "multipleLookupValues",
    "externalSyncSource",
    "aiText",
    "button",
    "createdBy",
    "lastModifiedBy",
])

# Name patterns that indicate a computed field (fallback when schema type is unavailable)
_COMPUTED_NAME_PATTERNS = [
    "(from ",    # lookup fields: "Field (from Table)"
]


def _get_computed_fields(entity: str) -> set:
    """Get the set of computed (read-only) field names for an entity.

    Checks both the schema field type and name-based heuristics.
    """
    computed = set()
    try:
        schema_data = schema_service.load()
    except Exception:
        return computed

    entity_lower = entity.lower().strip()
    entity_mapping = {
        "student": "students",
        "parent": "parents",
        "contractor": "contractors",
        "class": "classes",
    }
    normalized = entity_mapping.get(entity_lower, entity_lower)

    for table in schema_data.get("tables", []):
        table_name_lower = table.get("name", "").lower().strip()
        table_name_normalized = table_name_lower.replace(" ", "_")
        entity_as_spaces = normalized.replace("_", " ")
        if (
            table_name_lower == normalized
            or table_name_lower == entity_lower
            or table_name_lower == entity_as_spaces
            or table_name_normalized == normalized
            or normalized in table_name_lower
            or entity_as_spaces in table_name_lower
        ):
            for field in table.get("fields", []):
                field_name = field.get("name", "")
                field_type = field.get("type", "")
                if field_type in _COMPUTED_FIELD_TYPES:
                    computed.add(field_name)
                elif any(pat in field_name.lower() for pat in _COMPUTED_NAME_PATTERNS):
                    computed.add(field_name)
            break

    return computed


def _strip_computed_fields(fields: Dict[str, Any], entity: str) -> Dict[str, Any]:
    """Remove computed fields from a dict of fields before writing to Airtable."""
    computed = _get_computed_fields(entity)
    if not computed:
        return fields
    stripped = {k: v for k, v in fields.items() if k not in computed}
    removed = set(fields.keys()) - set(stripped.keys())
    if removed:
        logger.info(
            "Stripped computed fields before Airtable write",
            extra={"entity": entity, "stripped_fields": sorted(removed)},
        )
    return stripped


import re

_AIRTABLE_FIELD_ERROR_PATTERNS = [
    re.compile(r'Field "([^"]+)" cannot accept a value because the field is computed'),
    re.compile(r'Field "([^"]+)" cannot accept the provided value'),
]


def _safe_update(table, record_id: str, fields: Dict[str, Any], entity: str, max_retries: int = 10) -> Dict:
    """Update an Airtable record, automatically retrying if field errors occur.

    Airtable returns 422 errors when you try to write to a computed field or
    send an invalid value for a field. This function catches those errors,
    strips the offending field, and retries — handling cases where the local
    schema snapshot is stale or incomplete.
    """
    remaining = dict(fields)
    stripped = []

    for attempt in range(max_retries):
        try:
            return table.update(record_id, remaining, typecast=True)
        except Exception as exc:
            error_str = str(exc)
            bad_field = None
            for pattern in _AIRTABLE_FIELD_ERROR_PATTERNS:
                match = pattern.search(error_str)
                if match:
                    bad_field = match.group(1)
                    break
            if bad_field and attempt < max_retries - 1:
                stripped.append(bad_field)
                remaining.pop(bad_field, None)
                logger.warning(
                    "Airtable rejected field, retrying without it",
                    extra={
                        "entity": entity,
                        "record_id": record_id,
                        "rejected_field": bad_field,
                        "attempt": attempt + 1,
                        "remaining_fields": len(remaining),
                    },
                )
                if not remaining:
                    raise
                continue
            # Not a recognized field error or out of retries — re-raise
            raise

    # Should never reach here, but just in case
    return table.update(record_id, remaining, typecast=True)


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
            # Normalize both entity and table name by replacing underscores/spaces
            table_name_normalized = table_name_lower.replace(" ", "_")
            entity_as_spaces = normalized_entity.replace("_", " ")

            if (table_name_lower == normalized_entity or
                table_name_lower == entity_lower or
                table_name_lower == entity_as_spaces or
                table_name_normalized == normalized_entity or
                normalized_entity in table_name_lower or
                entity_as_spaces in table_name_lower):
                table_id = table.get("id")
                break

        if not table_id:
            # Try environment variable fallback
            # Try both AIRTABLE_ and AT_ prefixes for compatibility
            env_key_airtable = f"AIRTABLE_{normalized_entity.upper()}_TABLE"
            env_key_at = f"AT_{normalized_entity.upper()}_TABLE"
            table_id = os.getenv(env_key_airtable) or os.getenv(env_key_at)

        if not table_id:
            logger.warning(
                "Table not found for entity",
                extra={"entity": entity, "normalized": normalized_entity, "request_id": request_id},
            )
            return {"records": {}, "count": 0, "error": f"Table not found for entity: {entity}"}

        # Get Airtable API client using Personal Access Token (PAT)
        # Try environment variable first, then Secret Manager for local development
        from backend.utils.secrets import get_secret
        pat = get_secret("AIRTABLE_PAT")

        if not pat:
            raise HTTPException(
                status_code=500,
                detail="AIRTABLE_PAT not found in environment variables or Secret Manager. "
                       "Set AIRTABLE_PAT environment variable or ensure it exists in Google Cloud Secret Manager."
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


@app.get("/airtable/records/{entity}/search")
def search_airtable_records(
    entity: str,
    q: str = "",
    request: Request = None,
    user: dict = Depends(verify_firebase_token),
):
    """Search records in an Airtable table by primary field value.

    Returns up to 20 matching records with their ID and primary field value.
    If no query is provided, returns the first 20 records.
    """
    request_id = getattr(request.state, "request_id", "unknown") if request else "unknown"

    try:
        base_id, table_id = _resolve_entity_to_table(entity)
        table = _get_airtable_table(base_id, table_id)

        # Find the primary field name from schema
        schema_data = schema_service.load()
        primary_field_name = None
        primary_field_id = None
        for t in schema_data.get("tables", []):
            if t.get("id") == table_id:
                primary_field_id = t.get("primaryFieldId")
                for f in t.get("fields", []):
                    if f.get("id") == primary_field_id:
                        primary_field_name = f.get("name")
                        break
                break

        # Build formula to search by primary field
        formula = None
        if q and primary_field_name:
            safe_q = q.replace("'", "\\'")
            formula = f"FIND(LOWER('{safe_q}'), LOWER({{{primary_field_name}}}))"

        fetched = list(table.all(formula=formula, max_records=20))

        results = []
        for record in fetched:
            rid = record.get("id")
            fields = record.get("fields", {})
            display_name = fields.get(primary_field_name, rid) if primary_field_name else rid
            results.append({
                "id": rid,
                "name": str(display_name),
            })

        logger.info(
            "Searched Airtable records",
            extra={
                "entity": entity,
                "query": q,
                "results": len(results),
                "request_id": request_id,
            },
        )

        return {"records": results, "count": len(results)}

    except HTTPException:
        raise
    except Exception as exc:
        logger.error(
            "Failed to search Airtable records",
            extra={"entity": entity, "query": q, "error": str(exc), "request_id": request_id},
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"error": "Failed to search records", "message": str(exc)},
        )


# Airtable Record Write Endpoints


class UpdateRecordRequest(BaseModel):
    """Request body for updating an Airtable record."""
    fields: Dict[str, Any]


class MergeRecordsRequest(BaseModel):
    """Request body for merging duplicate Airtable records."""
    primary_record_id: str
    secondary_record_ids: List[str]
    merged_fields: Dict[str, Any]


@app.patch("/airtable/records/{entity}/{record_id}")
def update_airtable_record(
    entity: str,
    record_id: str,
    body: UpdateRecordRequest,
    request: Request,
    user: dict = Depends(verify_firebase_token),
):
    """Update specific fields on an Airtable record.

    Returns the updated record data.
    """
    request_id = getattr(request.state, "request_id", "unknown")
    uid = user.get("uid", "unknown")

    logger.info(
        "Airtable record update requested",
        extra={
            "entity": entity,
            "record_id": record_id,
            "fields": list(body.fields.keys()),
            "user_uid": uid,
            "request_id": request_id,
        },
    )

    if not body.fields:
        raise HTTPException(status_code=400, detail="No fields provided for update")

    try:
        base_id, table_id = _resolve_entity_to_table(entity)
        table = _get_airtable_table(base_id, table_id)

        safe_fields = _strip_computed_fields(body.fields, entity)
        if not safe_fields:
            raise HTTPException(
                status_code=400,
                detail="No writable fields remaining after removing computed fields",
            )

        updated = _safe_update(table, record_id, safe_fields, entity)

        logger.info(
            "Airtable record updated successfully",
            extra={
                "entity": entity,
                "record_id": record_id,
                "user_uid": uid,
                "request_id": request_id,
            },
        )

        return {
            "record": {
                "id": updated.get("id"),
                "fields": updated.get("fields", {}),
                "createdTime": updated.get("createdTime"),
            }
        }
    except HTTPException:
        raise
    except Exception as exc:
        logger.error(
            "Failed to update Airtable record",
            extra={"entity": entity, "record_id": record_id, "error": str(exc)},
            exc_info=True,
        )
        raise HTTPException(
            status_code=500,
            detail=f"Failed to update record: {str(exc)}",
        )


@app.delete("/airtable/records/{entity}/{record_id}")
def delete_airtable_record(
    entity: str,
    record_id: str,
    request: Request,
    user: dict = Depends(verify_firebase_token),
):
    """Delete an Airtable record.

    Returns deletion confirmation.
    """
    request_id = getattr(request.state, "request_id", "unknown")
    uid = user.get("uid", "unknown")

    logger.info(
        "Airtable record delete requested",
        extra={
            "entity": entity,
            "record_id": record_id,
            "user_uid": uid,
            "request_id": request_id,
        },
    )

    try:
        base_id, table_id = _resolve_entity_to_table(entity)
        table = _get_airtable_table(base_id, table_id)

        result = table.delete(record_id)

        logger.info(
            "Airtable record deleted successfully",
            extra={
                "entity": entity,
                "record_id": record_id,
                "deleted": result.get("deleted", False),
                "user_uid": uid,
                "request_id": request_id,
            },
        )

        return {"id": record_id, "deleted": result.get("deleted", True)}
    except HTTPException:
        raise
    except Exception as exc:
        logger.error(
            "Failed to delete Airtable record",
            extra={"entity": entity, "record_id": record_id, "error": str(exc)},
            exc_info=True,
        )
        raise HTTPException(
            status_code=500,
            detail=f"Failed to delete record: {str(exc)}",
        )


@app.post("/airtable/records/{entity}/merge")
def merge_airtable_records(
    entity: str,
    body: MergeRecordsRequest,
    request: Request,
    user: dict = Depends(verify_firebase_token),
):
    """Merge duplicate records: update primary with merged fields, delete secondaries.

    This is a compound operation. If the update succeeds but a delete fails,
    the response includes partial results with error details.
    """
    request_id = getattr(request.state, "request_id", "unknown")
    uid = user.get("uid", "unknown")

    logger.info(
        "Airtable merge requested",
        extra={
            "entity": entity,
            "primary": body.primary_record_id,
            "secondaries": body.secondary_record_ids,
            "merged_field_count": len(body.merged_fields),
            "user_uid": uid,
            "request_id": request_id,
        },
    )

    if not body.secondary_record_ids:
        raise HTTPException(status_code=400, detail="No secondary records to merge")
    if body.primary_record_id in body.secondary_record_ids:
        raise HTTPException(
            status_code=400, detail="Primary record cannot also be a secondary"
        )

    try:
        base_id, table_id = _resolve_entity_to_table(entity)
        table = _get_airtable_table(base_id, table_id)

        # Step 1: Update primary record with merged fields (strip computed fields)
        safe_fields = _strip_computed_fields(body.merged_fields, entity)
        updated = _safe_update(table, body.primary_record_id, safe_fields, entity)

        # Step 2: Delete secondary records one by one
        delete_results = []
        delete_errors = []
        for secondary_id in body.secondary_record_ids:
            try:
                table.delete(secondary_id)
                delete_results.append({"id": secondary_id, "deleted": True})
            except Exception as del_exc:
                logger.error(
                    "Failed to delete secondary record during merge",
                    extra={
                        "record_id": secondary_id,
                        "error": str(del_exc),
                        "request_id": request_id,
                    },
                )
                delete_errors.append({"id": secondary_id, "error": str(del_exc)})

        response = {
            "primary_record": {
                "id": updated.get("id"),
                "fields": updated.get("fields", {}),
                "createdTime": updated.get("createdTime"),
            },
            "deleted": delete_results,
            "errors": delete_errors,
            "success": len(delete_errors) == 0,
        }

        logger.info(
            "Airtable merge completed",
            extra={
                "entity": entity,
                "primary": body.primary_record_id,
                "deleted_count": len(delete_results),
                "error_count": len(delete_errors),
                "user_uid": uid,
                "request_id": request_id,
            },
        )

        return response
    except HTTPException:
        raise
    except Exception as exc:
        logger.error(
            "Failed to merge Airtable records",
            extra={"entity": entity, "error": str(exc)},
            exc_info=True,
        )
        raise HTTPException(
            status_code=500,
            detail=f"Failed to merge records: {str(exc)}",
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
            "value_checks": {},
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
        
        valid_categories = ["duplicates", "relationships", "required_fields", "value_checks", "attendance_rules"]
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

class IssueChatRequest(BaseModel):
    """Request body for AI chat about issues."""
    messages: List[Dict[str, str]]
    issue_context: str
    record_ids_by_entity: Dict[str, List[str]] = {}


@app.post("/chat/issues")
def chat_about_issues(
    body: IssueChatRequest,
    request: Request,
    user: dict = Depends(verify_firebase_token),
):
    """AI chat endpoint for asking questions about data integrity issues."""
    try:
        request_id = getattr(request.state, "request_id", None)

        logger.info(
            "Issue chat request received",
            extra={
                "message_count": len(body.messages),
                "context_length": len(body.issue_context),
                "entities_with_records": list(body.record_ids_by_entity.keys()),
                "request_id": request_id,
            },
        )

        service = IssueChatService()
        response_text = service.chat(
            body.messages, body.issue_context, body.record_ids_by_entity
        )

        return {"response": response_text}
    except HTTPException:
        raise
    except Exception as exc:
        logger.error(
            "Issue chat failed",
            extra={"error": str(exc), "request_id": getattr(request.state, "request_id", None)},
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"error": "Chat failed", "message": str(exc)},
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
        
        valid_categories = ["duplicates", "relationships", "required_fields", "value_checks", "attendance_rules"]
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
        
        valid_categories = ["duplicates", "relationships", "required_fields", "value_checks", "attendance_rules"]
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
        
        valid_categories = ["duplicates", "relationships", "required_fields", "value_checks", "attendance_rules"]
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


# ============================================================================
# Slack Webhook Admin Endpoints
# ============================================================================


class SlackWebhookRequest(BaseModel):
    """Request body for setting Slack webhook URL."""
    webhook_url: str


@app.get("/admin/slack-webhook", dependencies=[Depends(verify_firebase_token)])
def get_slack_webhook_status_endpoint(request: Request, user: dict = Depends(verify_firebase_token)):
    """Get the current status of Slack webhook configuration.
    
    Only shows whether webhook is configured and a masked URL - does not reveal the actual URL.
    Requires admin access.
    
    Returns:
        - configured: bool - Whether a webhook URL is set
        - source: str - Where the webhook is configured ('environment' or 'secret_manager')
        - masked_url: str - Partially masked URL for confirmation
    """
    request_id = getattr(request.state, "request_id", "unknown")
    
    # Check if user is admin
    if not user.get("isAdmin", False):
        logger.warning(
            "Non-admin user attempted to access Slack webhook status",
            extra={"user_id": user.get("uid"), "request_id": request_id},
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin access required",
        )
    
    try:
        from .services.slack_notifier import get_slack_webhook_status
        status_info = get_slack_webhook_status()
        logger.info(
            "Slack webhook status checked",
            extra={"configured": status_info.get("configured"), "request_id": request_id},
        )
        return status_info
    except Exception as exc:
        logger.error(
            "Failed to get Slack webhook status",
            extra={"error": str(exc), "request_id": request_id},
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"error": "Failed to get Slack webhook status", "message": str(exc)},
        )


@app.post("/admin/slack-webhook", dependencies=[Depends(verify_firebase_token)])
def set_slack_webhook_endpoint(
    request: Request,
    webhook_request: SlackWebhookRequest,
    user: dict = Depends(verify_firebase_token),
):
    """Set the Slack webhook URL in Google Secret Manager.
    
    Requires admin access.
    
    Args:
        webhook_request: Request body containing webhook_url
        
    Returns:
        - success: bool
        - message: str
    """
    request_id = getattr(request.state, "request_id", "unknown")
    
    # Check if user is admin
    if not user.get("isAdmin", False):
        logger.warning(
            "Non-admin user attempted to set Slack webhook",
            extra={"user_id": user.get("uid"), "request_id": request_id},
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin access required",
        )
    
    webhook_url = webhook_request.webhook_url
    
    # Validate webhook URL format
    if not webhook_url.startswith("https://hooks.slack.com/"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid Slack webhook URL. Must start with 'https://hooks.slack.com/'",
        )
    
    try:
        from .services.slack_notifier import set_slack_webhook_secret
        success = set_slack_webhook_secret(webhook_url)
        
        if success:
            logger.info(
                "Slack webhook URL updated",
                extra={"user_id": user.get("uid"), "request_id": request_id},
            )
            return {"success": True, "message": "Slack webhook URL saved successfully"}
        else:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to save Slack webhook URL to Secret Manager",
            )
    except HTTPException:
        raise
    except Exception as exc:
        logger.error(
            "Failed to set Slack webhook",
            extra={"error": str(exc), "request_id": request_id},
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"error": "Failed to set Slack webhook", "message": str(exc)},
        )


@app.post("/admin/slack-webhook/test", dependencies=[Depends(verify_firebase_token)])
def test_slack_webhook_endpoint(
    request: Request,
    user: dict = Depends(verify_firebase_token),
):
    """Send a test notification to verify Slack webhook is working.
    
    Requires admin access.
    
    Returns:
        - success: bool
        - message: str
    """
    request_id = getattr(request.state, "request_id", "unknown")
    
    # Check if user is admin
    if not user.get("isAdmin", False):
        logger.warning(
            "Non-admin user attempted to test Slack webhook",
            extra={"user_id": user.get("uid"), "request_id": request_id},
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin access required",
        )
    
    try:
        from .services.slack_notifier import get_slack_notifier
        notifier = get_slack_notifier()
        
        # Create a test notification
        success = notifier.send_notification(
            run_id="test-notification",
            status="warning",  # Use warning to ensure it actually sends
            issue_counts={"test": 1},
            trigger="test",
            duration_ms=1000,
            error_message=None,
        )
        
        if success:
            logger.info(
                "Slack test notification sent",
                extra={"user_id": user.get("uid"), "request_id": request_id},
            )
            return {"success": True, "message": "Test notification sent successfully"}
        else:
            return {
                "success": False,
                "message": "Webhook not configured or notification failed. Check server logs for details.",
            }
    except Exception as exc:
        logger.error(
            "Failed to send test notification",
            extra={"error": str(exc), "request_id": request_id},
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"error": "Failed to send test notification", "message": str(exc)},
        )


# ===== School Year Management =====

@app.get("/admin/school-years/current", dependencies=[Depends(verify_firebase_token)])
async def get_current_school_years(
    request: Request,
    user: dict = Depends(verify_firebase_token)
):
    """Get currently active school years with caching info.

    Returns the active school years (current + 3 future years) from external API.
    Year transitions are handled externally in the toolkit API.
    """
    request_id = str(uuid.uuid4())
    logger.info(
        "Fetching current school years",
        extra={"user_id": user.get("uid"), "request_id": request_id}
    )

    try:
        from backend.services.school_year_service import SchoolYearService
        from .clients.firestore import FirestoreClient
        from .config.config_loader import load_runtime_config

        # Create Firestore client
        config = load_runtime_config()
        firestore_client = FirestoreClient(config.firestore)

        school_year_service = SchoolYearService(firestore_client)
        active_years = school_year_service.get_active_school_years()

        # Get cached data for display
        doc = firestore_client.db.collection("system_config").document("active_school_years").get()
        cache_data = doc.to_dict() if doc.exists else {}

        return {
            "active_years": active_years,
            "current_year": cache_data.get("current_year"),
            "future_years": cache_data.get("future_years", []),
            "num_future_years": cache_data.get("num_future_years", 0),
            "cached_at": cache_data.get("cached_at"),
            "field_mappings": school_year_service._school_year_config.get("field_mappings", {})
        }
    except ValueError as e:
        logger.error(
            "Configuration error fetching school years",
            extra={"error": str(e), "request_id": request_id},
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "Configuration error", "message": str(e)},
        )
    except Exception as exc:
        logger.error(
            "Failed to fetch school years",
            extra={"error": str(exc), "request_id": request_id},
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"error": "Failed to fetch school years", "message": str(exc)},
        )


@app.post("/admin/school-years/refresh", dependencies=[Depends(verify_firebase_token)])
async def refresh_school_years(
    request: Request,
    user: dict = Depends(verify_firebase_token)
):
    """Force refresh of active school years from external API.

    Bypasses cache and fetches fresh data from the external school year API.
    Updates the Firestore cache with the latest values.
    """
    request_id = str(uuid.uuid4())
    logger.info(
        "Refreshing school years from external API",
        extra={"user_id": user.get("uid"), "request_id": request_id}
    )

    try:
        from backend.services.school_year_service import SchoolYearService
        from backend.clients.firestore import FirestoreClient
        from backend.config.config_loader import load_runtime_config

        # Create Firestore client
        config = load_runtime_config()
        firestore_client = FirestoreClient(config.firestore)

        school_year_service = SchoolYearService(firestore_client)
        result = school_year_service.refresh_cache()

        logger.info(
            "School years refreshed successfully",
            extra={
                "user_id": user.get("uid"),
                "request_id": request_id,
                "active_years": result["active_years"],
                "current_year": result["current_year"],
                "upcoming_year": result["upcoming_year"]
            }
        )

        return {
            "success": True,
            "message": "School years refreshed successfully",
            **result
        }
    except ValueError as e:
        logger.error(
            "Configuration error refreshing school years",
            extra={"error": str(e), "request_id": request_id},
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "Configuration error", "message": str(e)},
        )
    except Exception as exc:
        logger.error(
            "Failed to refresh school years",
            extra={"error": str(exc), "request_id": request_id},
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"error": "Failed to refresh school years", "message": str(exc)},
        )


# ── API Key Management ──────────────────────────────────────────────────────────

class CreateApiKeyRequest(BaseModel):
    """Request body for creating an API key."""
    name: str


@app.get("/api-keys", dependencies=[Depends(verify_firebase_token)])
def list_api_keys(request: Request, user: dict = Depends(verify_firebase_token)):
    """List the authenticated user's API keys."""
    request_id = getattr(request.state, "request_id", "unknown")
    uid = user.get("uid")

    try:
        from .clients.firestore import FirestoreClient
        from .config.config_loader import load_runtime_config

        config = load_runtime_config()
        firestore_client = FirestoreClient(config.firestore)
        client = firestore_client._get_client()

        keys_ref = client.collection("users").document(uid).collection("api_keys")
        keys = []
        for doc in keys_ref.order_by("created_at", direction="DESCENDING").stream():
            data = doc.to_dict()
            keys.append({
                "id": doc.id,
                "name": data.get("name", ""),
                "key_prefix": data.get("key_prefix", ""),
                "created_at": data.get("created_at").isoformat() if data.get("created_at") else None,
                "last_used_at": data.get("last_used_at").isoformat() if data.get("last_used_at") else None,
            })

        return {"keys": keys}
    except Exception as exc:
        logger.error(
            "Failed to list API keys",
            extra={"uid": uid, "error": str(exc), "request_id": request_id},
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"error": "Failed to list API keys", "message": str(exc)},
        )


@app.post("/api-keys", dependencies=[Depends(verify_firebase_token)])
def create_api_key(body: CreateApiKeyRequest, request: Request, user: dict = Depends(verify_firebase_token)):
    """Create a new API key for the authenticated user. Returns the full key exactly once."""
    import hashlib
    import secrets as secrets_mod

    request_id = getattr(request.state, "request_id", "unknown")
    uid = user.get("uid")
    name = body.name.strip()

    if not name:
        raise HTTPException(status_code=400, detail="Name is required")
    if len(name) > 100:
        raise HTTPException(status_code=400, detail="Name must be 100 characters or fewer")

    try:
        from google.cloud import firestore as firestore_lib
        from .clients.firestore import FirestoreClient
        from .config.config_loader import load_runtime_config

        config = load_runtime_config()
        firestore_client = FirestoreClient(config.firestore)
        client = firestore_client._get_client()

        # Generate key
        raw_key = "dim_" + secrets_mod.token_hex(32)
        key_hash = hashlib.sha256(raw_key.encode()).hexdigest()
        key_prefix = raw_key[:12] + "..."

        keys_ref = client.collection("users").document(uid).collection("api_keys")
        doc_ref = keys_ref.document()
        doc_ref.set({
            "name": name,
            "key_hash": key_hash,
            "key_prefix": key_prefix,
            "created_at": firestore_lib.SERVER_TIMESTAMP,
            "last_used_at": None,
            "uid": uid,
        })

        logger.info(
            "API key created",
            extra={"uid": uid, "key_id": doc_ref.id, "request_id": request_id},
        )

        return {
            "id": doc_ref.id,
            "name": name,
            "key": raw_key,
            "key_prefix": key_prefix,
            "created_at": None,  # SERVER_TIMESTAMP resolves server-side
        }
    except HTTPException:
        raise
    except Exception as exc:
        logger.error(
            "Failed to create API key",
            extra={"uid": uid, "error": str(exc), "request_id": request_id},
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"error": "Failed to create API key", "message": str(exc)},
        )


@app.delete("/api-keys/{key_id}", dependencies=[Depends(verify_firebase_token)])
def delete_api_key(key_id: str, request: Request, user: dict = Depends(verify_firebase_token)):
    """Delete an API key belonging to the authenticated user."""
    request_id = getattr(request.state, "request_id", "unknown")
    uid = user.get("uid")

    try:
        from .clients.firestore import FirestoreClient
        from .config.config_loader import load_runtime_config

        config = load_runtime_config()
        firestore_client = FirestoreClient(config.firestore)
        client = firestore_client._get_client()

        doc_ref = client.collection("users").document(uid).collection("api_keys").document(key_id)
        doc = doc_ref.get()

        if not doc.exists:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail={"error": "API key not found", "key_id": key_id},
            )

        doc_ref.delete()

        logger.info(
            "API key deleted",
            extra={"uid": uid, "key_id": key_id, "request_id": request_id},
        )

        return {"status": "success", "message": "API key deleted", "key_id": key_id}
    except HTTPException:
        raise
    except Exception as exc:
        logger.error(
            "Failed to delete API key",
            extra={"uid": uid, "key_id": key_id, "error": str(exc), "request_id": request_id},
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"error": "Failed to delete API key", "message": str(exc)},
        )
