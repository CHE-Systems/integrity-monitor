"""Firestore client wrapper used for run metadata and metrics."""

from __future__ import annotations

import hashlib
import logging
import math
import random
import re
import time
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeoutError
from datetime import datetime, timezone
from typing import Any, Callable, Dict, Optional, Set

try:
    from google.cloud import firestore
    from google.api_core import retry
except ImportError:
    firestore = None
    retry = None

from ..config.settings import FirestoreConfig

logger = logging.getLogger(__name__)


class FirestoreClient:
    """Firestore client for writing run metadata and metrics."""

    def __init__(self, config: FirestoreConfig):
        self._config = config
        self._client: firestore.Client | None = None

    def _get_client(self) -> firestore.Client:
        """Lazy initialization of Firestore client."""
        if self._client is None:
            if firestore is None:
                raise ImportError(
                    "google-cloud-firestore not installed. Install with: pip install google-cloud-firestore"
                )
            try:
                import os
                from google.auth.exceptions import DefaultCredentialsError
                from google.oauth2 import service_account
                
                # Determine project ID - prefer env vars, fallback to data-integrity-monitor (matches .firebaserc)
                project_id = (
                    os.getenv("GOOGLE_CLOUD_PROJECT")
                    or os.getenv("GCP_PROJECT_ID")
                    or "data-integrity-monitor"
                )
                
                # Try to initialize with explicit credentials path if set
                cred_path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
                if cred_path:
                    # Resolve relative paths relative to backend directory
                    original_path = cred_path
                    if not os.path.isabs(cred_path):
                        backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
                        resolved_path = os.path.join(backend_dir, cred_path)
                        if os.path.exists(resolved_path):
                            cred_path = resolved_path
                        elif not os.path.exists(cred_path):
                            # Try absolute path
                            cred_path = os.path.abspath(cred_path)
                    
                    if os.path.exists(cred_path):
                        # Load credentials explicitly
                        credentials = service_account.Credentials.from_service_account_file(cred_path)
                        # Use project_id from credentials if available, otherwise use determined project_id
                        cred_project_id = credentials.project_id if hasattr(credentials, 'project_id') and credentials.project_id else project_id
                        self._client = firestore.Client(credentials=credentials, project=cred_project_id)
                        logger.info(f"Firestore client initialized with credentials from {cred_path}")
                    else:
                        logger.warning(
                            f"Service account file not found at {original_path} (resolved to {cred_path}). "
                            f"Falling back to Application Default Credentials (ADC). "
                            f"To fix: either set up ADC with 'gcloud auth application-default login' "
                            f"or remove GOOGLE_APPLICATION_CREDENTIALS from your environment."
                        )
                        # Try default credentials with explicit project
                        try:
                            self._client = firestore.Client(project=project_id)
                            logger.info(f"Firestore client initialized with Application Default Credentials (project: {project_id})")
                        except DefaultCredentialsError:
                            # Re-raise with more helpful message
                            raise RuntimeError(
                                f"Firestore credentials not configured. "
                                f"GOOGLE_APPLICATION_CREDENTIALS is set to '{original_path}' but the file was not found. "
                                f"Application Default Credentials (ADC) are also not available. "
                                f"To fix: either set up ADC with 'gcloud auth application-default login' "
                                f"or remove/unset GOOGLE_APPLICATION_CREDENTIALS from your environment."
                            ) from None
                else:
                    # No explicit path, try default credentials with explicit project
                    try:
                        self._client = firestore.Client(project=project_id)
                        logger.info(f"Firestore client initialized with Application Default Credentials (project: {project_id})")
                    except DefaultCredentialsError:
                        # Re-raise with more helpful message
                        raise RuntimeError(
                            f"Firestore credentials not configured. "
                            f"No GOOGLE_APPLICATION_CREDENTIALS set and Application Default Credentials (ADC) are not available. "
                            f"To fix: run 'gcloud auth application-default login' to set up ADC."
                        ) from None
            except DefaultCredentialsError as exc:
                error_msg = str(exc)
                raise RuntimeError(
                    f"Firestore credentials not configured. "
                    f"Set GOOGLE_APPLICATION_CREDENTIALS environment variable to point to your service account JSON file. "
                    f"Error: {error_msg}"
                ) from exc
            except Exception as exc:
                error_msg = str(exc)
                if "credentials" in error_msg.lower() or "authentication" in error_msg.lower():
                    raise RuntimeError(
                        f"Firestore authentication failed. "
                        f"Please check your GOOGLE_APPLICATION_CREDENTIALS setting. "
                        f"Error: {error_msg}"
                    ) from exc
                raise
        return self._client
    
    @property
    def db(self) -> firestore.Client:
        """Property to access the Firestore client directly (for backward compatibility)."""
        return self._get_client()

    def record_run(self, run_id: str, payload: Dict[str, Any]) -> None:
        """Write run summary to Firestore integrity_runs collection."""
        try:
            client = self._get_client()
            doc_ref = client.collection(self._config.runs_collection).document(run_id)
            
            # Ensure timestamps are present
            data = payload.copy()
            # Only set started_at if it doesn't exist and we're not cancelling
            # WARNING: This fallback can cause bugs if called during updates without started_at
            # All callers should include started_at explicitly to avoid incorrect timestamps
            if "started_at" not in data and data.get("status") != "cancelled":
                logger.warning(
                    "started_at not in data for record_run - using current time as fallback. "
                    "This may cause incorrect timestamps. Caller should include started_at explicitly.",
                    extra={"run_id": run_id, "status": data.get("status")},
                )
                data["started_at"] = datetime.now(timezone.utc)
            if "ended_at" not in data and "status" in data and data["status"] != "running":
                data["ended_at"] = datetime.now(timezone.utc)
            
            doc_ref.set(data, merge=True)
            logger.info(
                "Recorded run summary",
                extra={"collection": self._config.runs_collection, "run_id": run_id},
            )
        except RuntimeError as exc:
            # Re-raise credential errors with clear message
            raise
        except Exception as exc:
            logger.error(
                "Failed to record run summary",
                extra={"run_id": run_id, "error": str(exc)},
                exc_info=True,
            )
            raise

    def record_metrics(self, payload: Dict[str, Any]) -> None:
        """Write daily metrics to Firestore integrity_metrics_daily collection."""
        try:
            client = self._get_client()
            # Use YYYYMMDD format for document ID
            date_str = datetime.now(timezone.utc).strftime("%Y%m%d")
            doc_ref = client.collection(self._config.metrics_collection).document(date_str)
            
            data = payload.copy()
            data["date"] = date_str
            data["updated_at"] = datetime.now(timezone.utc)
            
            doc_ref.set(data, merge=True)
            logger.info(
                "Recorded daily metrics",
                extra={"collection": self._config.metrics_collection, "date": date_str},
            )
        except Exception as exc:
            logger.error(
                "Failed to record metrics",
                extra={"error": str(exc)},
                exc_info=True,
            )
            raise

    def _generate_doc_id(self, issue: Dict[str, Any]) -> str:
        """Generate a Firestore document ID from an issue.
        
        Uses rule_id + record_id as the base, with sanitization for Firestore
        document ID requirements (1500 byte limit, character restrictions).
        
        Args:
            issue: Issue dictionary with rule_id and record_id
            
        Returns:
            Valid Firestore document ID
        """
        doc_id_parts = f"{issue.get('rule_id', '')}_{issue.get('record_id', '')}"

        # Check if we need to hash (length exceeds 1500 bytes)
        if len(doc_id_parts.encode('utf-8')) > 1500:
            doc_id = hashlib.sha256(doc_id_parts.encode('utf-8')).hexdigest()
        else:
            # Sanitize invalid characters
            doc_id = doc_id_parts.replace('/', '_').replace('\\', '_')
            # Remove leading/trailing periods
            doc_id = doc_id.strip('.')
            # Replace consecutive periods with single period
            doc_id = re.sub(r'\.{2,}', '.', doc_id)
            # Ensure it doesn't match __.*__ pattern by replacing if needed
            if re.match(r'^__.*__$', doc_id):
                doc_id = f"id_{doc_id}"
            # Ensure not solely . or .. or empty
            if doc_id in ('', '.', '..'):
                doc_id = hashlib.sha256(doc_id_parts.encode('utf-8')).hexdigest()
        
        return doc_id

    def _check_existing_documents(
        self,
        collection_ref: Any,
        doc_ids: list[str],
        progress_callback: Optional[Callable[[int, int, float], None]] = None,
        total_issues: Optional[int] = None,
    ) -> Set[str]:
        """Check which documents already exist in Firestore.
        
        Uses get_all() for small batches, or skips check for very large batches.
        
        Args:
            collection_ref: Firestore collection reference
            doc_ids: List of document IDs to check
            progress_callback: Optional callback function(current, total, percentage) called during check
            total_issues: Total number of issues (for progress calculation)
            
        Returns:
            Set of document IDs that already exist
        """
        if not doc_ids:
            return set()
        
        total_to_check = total_issues or len(doc_ids)
        
        # For very large batches (>5000), skip the existence check
        # We'll use merge=True and determine new vs existing by checking first_seen_in_run field
        LARGE_BATCH_THRESHOLD = 5000
        if len(doc_ids) > LARGE_BATCH_THRESHOLD:
            logger.info(
                f"Skipping existence check for {len(doc_ids)} issues (using merge=True instead)",
                extra={"total": len(doc_ids), "threshold": LARGE_BATCH_THRESHOLD}
            )
            if progress_callback:
                try:
                    # Mark check as complete immediately
                    progress_callback(0, total_to_check, 10.0)
                except Exception:
                    pass
            # Return empty set - all will be treated as potentially new
            # We'll determine new vs existing after writing by checking first_seen_in_run
            return set()
        
        existing_ids: Set[str] = set()
        
        # For smaller batches, use get_all() in chunks of 100
        chunk_size = 100
        for i in range(0, len(doc_ids), chunk_size):
            chunk = doc_ids[i:i + chunk_size]
            doc_refs = [collection_ref.document(doc_id) for doc_id in chunk]
            
            try:
                # Batch read documents
                docs = self._get_client().get_all(doc_refs)
                for doc in docs:
                    if doc.exists:
                        existing_ids.add(doc.id)
                
                # Call progress callback after each chunk
                if progress_callback:
                    checked_count = min(i + chunk_size, len(doc_ids))
                    try:
                        # Estimate progress: checking is ~10% of total work, writing is ~90%
                        check_progress = (checked_count / len(doc_ids)) * 10.0 if len(doc_ids) > 0 else 0.0
                        progress_callback(0, total_to_check, check_progress)
                    except Exception:
                        pass
            except Exception as exc:
                logger.warning(
                    "Error checking existing documents",
                    extra={"error": str(exc), "chunk_size": len(chunk)},
                    exc_info=True,
                )
                # Continue with other chunks even if one fails
        
        return existing_ids

    def _commit_batch_with_retry(
        self,
        batch: Any,
        batch_count: int,
        max_retries: int = 3,
    ) -> None:
        """Commit a Firestore batch with retry logic for transient errors.
        
        Args:
            batch: Firestore batch object to commit
            batch_count: Number of operations in the batch (for logging)
            max_retries: Maximum number of retry attempts
            
        Raises:
            Exception: If batch commit fails after all retries
        """
        last_exception = None
        
        for attempt in range(max_retries):
            try:
                # Use ThreadPoolExecutor with timeout to prevent indefinite hanging
                # This is critical for Cloud Run where resources are limited
                executor = ThreadPoolExecutor(max_workers=1)
                try:
                    future = executor.submit(batch.commit)
                    # 30 second timeout per attempt (reasonable for 500 operations)
                    future.result(timeout=30)
                    
                    if attempt > 0:
                        logger.info(
                            f"Batch commit succeeded on retry attempt {attempt + 1}",
                            extra={"batch_size": batch_count, "attempt": attempt + 1}
                        )
                    return
                except FuturesTimeoutError:
                    # Treat timeout as a retryable error
                    error_msg = f"Batch commit timed out after 30 seconds"
                    logger.warning(
                        error_msg,
                        extra={"batch_size": batch_count, "attempt": attempt + 1}
                    )
                    raise Exception(error_msg)
                finally:
                    executor.shutdown(wait=False, cancel_futures=True)
            except Exception as exc:
                last_exception = exc
                # Check if this is a retryable error
                error_str = str(exc).lower()
                is_retryable = any(keyword in error_str for keyword in [
                    "deadline exceeded",
                    "unavailable",
                    "resource exhausted",
                    "quota",
                    "rate limit",
                    "timeout",
                    "connection",
                ])
                
                if not is_retryable or attempt == max_retries - 1:
                    # Not retryable or last attempt - log and re-raise
                    logger.error(
                        "Failed to commit batch to Firestore",
                        extra={
                            "error": str(exc),
                            "batch_size": batch_count,
                            "attempt": attempt + 1,
                            "max_retries": max_retries,
                            "retryable": is_retryable,
                        },
                        exc_info=True,
                    )
                    raise
                
                # Retryable error - wait and retry
                wait_time = 2 ** attempt  # Exponential backoff: 1s, 2s, 4s
                logger.warning(
                    f"Batch commit failed (retryable error), retrying in {wait_time}s",
                    extra={
                        "error": str(exc),
                        "batch_size": batch_count,
                        "attempt": attempt + 1,
                        "wait_time": wait_time,
                    },
                )
                time.sleep(wait_time)
        
        # Should never reach here, but just in case
        if last_exception:
            raise last_exception

    def record_issues(self, issues: list[Dict[str, Any]], progress_callback: Optional[Callable[[int, int, float], None]] = None) -> tuple[int, int]:
        """Write individual issues to Firestore integrity_issues collection.
        
        Args:
            issues: List of issue dictionaries with rule_id, record_id, etc.
            progress_callback: Optional callback function(current, total, percentage) called after each batch
            
        Returns:
            Tuple of (new_issues_count, total_issues_count)
        """
        if not issues:
            logger.info("No issues to write to Firestore")
            return (0, 0)
        
        try:
            client = self._get_client()
            collection_ref = client.collection(self._config.issues_collection)
            
            # Generate all document IDs first
            issue_doc_pairs = []
            for issue in issues:
                doc_id = self._generate_doc_id(issue)
                issue_doc_pairs.append((doc_id, issue))
            
            # Validate no duplicate document IDs are being written in the same batch
            doc_ids_seen = set()
            duplicate_doc_ids = []
            for doc_id, issue in issue_doc_pairs:
                if doc_id in doc_ids_seen:
                    duplicate_doc_ids.append((doc_id, issue.get('rule_id'), issue.get('record_id')))
                doc_ids_seen.add(doc_id)
            
            if duplicate_doc_ids:
                logger.error(
                    f"Found {len(duplicate_doc_ids)} duplicate document IDs before writing to Firestore",
                    extra={
                        "duplicate_count": len(duplicate_doc_ids),
                        "total_issues": len(issue_doc_pairs)
                    }
                )
                for doc_id, rule_id, record_id in duplicate_doc_ids[:10]:  # Log first 10
                    logger.error(
                        f"Duplicate doc_id: {doc_id} (rule: {rule_id}, record: {record_id})",
                        extra={"doc_id": doc_id, "rule_id": rule_id, "record_id": record_id}
                    )
            
            # Check which documents already exist
            all_doc_ids = [doc_id for doc_id, _ in issue_doc_pairs]
            total_issues = len(all_doc_ids)
            
            # Notify progress callback before existence check
            if progress_callback:
                try:
                    progress_callback(0, total_issues, 0.0)
                except Exception:
                    pass
            
            # Check which documents already exist (with progress logging)
            existing_ids = self._check_existing_documents(collection_ref, all_doc_ids, progress_callback, total_issues)
            
            # If we skipped the check (large batch), treat all as potentially new
            # We'll determine new vs existing after writing by checking first_seen_in_run
            skipped_check = len(existing_ids) == 0 and len(all_doc_ids) > 5000
            
            if skipped_check:
                # For large batches, write all issues and determine new vs existing after
                new_issues = issue_doc_pairs  # Treat all as potentially new
                existing_issues = []
                logger.info(
                    f"Skipped existence check for {len(all_doc_ids)} issues - will determine new vs existing after writing",
                    extra={"total": len(issue_doc_pairs)},
                )
            else:
                # Separate new issues from existing issues
                new_issues = [(doc_id, issue) for doc_id, issue in issue_doc_pairs if doc_id not in existing_ids]
                existing_issues = [(doc_id, issue) for doc_id, issue in issue_doc_pairs if doc_id in existing_ids]
                existing_count = len(existing_issues)
                
                if existing_count > 0:
                    logger.info(
                        "Found existing issues that will be updated with run_id",
                        extra={"existing": existing_count, "new": len(new_issues), "total": len(issue_doc_pairs)},
                    )
                else:
                    logger.info(
                        "All issues are new",
                        extra={"new": len(new_issues), "total": len(issue_doc_pairs)},
                    )
            
            if not new_issues and not existing_issues:
                logger.info("No issues to process")
                return (0, 0)
            
            batch = client.batch()
            batch_count = 0
            total_written = 0
            total_updated = 0
            total_new_issues = len(new_issues) if not skipped_check else 0  # Will calculate after writing
            
            # Process new issues first (or all issues if we skipped check)
            for doc_id, issue in new_issues:
                doc_ref = collection_ref.document(doc_id)
                
                # Prepare issue data with timestamps
                issue_data = issue.copy()
                if "created_at" not in issue_data:
                    issue_data["created_at"] = datetime.now(timezone.utc)
                issue_data["updated_at"] = datetime.now(timezone.utc)
                if "status" not in issue_data:
                    issue_data["status"] = "open"
                
                # Set first_seen_in_run for new issues (only if run_id is provided)
                if "run_id" in issue_data and "first_seen_in_run" not in issue_data:
                    issue_data["first_seen_in_run"] = issue_data["run_id"]
                
                batch.set(doc_ref, issue_data, merge=True)
                batch_count += 1
                total_written += 1
                
                # Firestore batch limit is 500 operations
                if batch_count >= 500:
                    try:
                        self._commit_batch_with_retry(batch, batch_count)
                    except Exception as exc:
                        logger.error(
                            "Failed to commit batch of new issues to Firestore",
                            extra={
                                "error": str(exc),
                                "batch_size": batch_count,
                                "total_written": total_written,
                                "total_updated": total_updated,
                            },
                            exc_info=True,
                        )
                        raise
                    if progress_callback:
                        try:
                            original_total = len(issue_doc_pairs)
                            # Writing is 90% of work (checking was 10%), so progress = 10% + (written/total * 90%)
                            written_progress = (total_written / original_total * 90.0) if original_total > 0 else 0.0
                            progress_callback(total_written + total_updated, original_total, 10.0 + written_progress)
                        except Exception:
                            pass
                    batch = client.batch()
                    batch_count = 0
            
            # Commit remaining new issues
            if batch_count > 0:
                try:
                    self._commit_batch_with_retry(batch, batch_count)
                except Exception as exc:
                    logger.error(
                        "Failed to commit final batch of new issues to Firestore",
                        extra={
                            "error": str(exc),
                            "batch_size": batch_count,
                            "total_written": total_written,
                            "total_updated": total_updated,
                        },
                        exc_info=True,
                    )
                    raise
                if progress_callback:
                    try:
                        original_total = len(issue_doc_pairs)
                        # Writing is 90% of work (checking was 10%), so progress = 10% + (written/total * 90%)
                        written_progress = (total_written / original_total * 90.0) if original_total > 0 else 0.0
                        progress_callback(total_written + total_updated, original_total, 10.0 + written_progress)
                    except Exception:
                        pass
                batch = client.batch()
                batch_count = 0
            
            # Now update existing issues with run_id (so they can be filtered by run_id)
            for doc_id, issue in existing_issues:
                doc_ref = collection_ref.document(doc_id)

                # Update run_id and updated_at for existing issues
                # Use set with merge=True instead of update to be more robust
                update_data = {
                    "updated_at": datetime.now(timezone.utc),
                }
                if "run_id" in issue:
                    update_data["run_id"] = issue["run_id"]

                batch.set(doc_ref, update_data, merge=True)
                batch_count += 1
                total_updated += 1
                
                # Firestore batch limit is 500 operations
                if batch_count >= 500:
                    try:
                        self._commit_batch_with_retry(batch, batch_count)
                    except Exception as exc:
                        logger.error(
                            "Failed to commit batch of existing issues to Firestore",
                            extra={
                                "error": str(exc),
                                "batch_size": batch_count,
                                "total_written": total_written,
                                "total_updated": total_updated,
                            },
                            exc_info=True,
                        )
                        raise
                    if progress_callback:
                        try:
                            original_total = len(issue_doc_pairs)
                            # Writing is 90% of work (checking was 10%), so progress = 10% + (written/total * 90%)
                            written_progress = ((total_written + total_updated) / original_total * 90.0) if original_total > 0 else 0.0
                            progress_callback(total_written + total_updated, original_total, 10.0 + written_progress)
                        except Exception:
                            pass
                    batch = client.batch()
                    batch_count = 0
            
            # Commit remaining updates
            if batch_count > 0:
                try:
                    self._commit_batch_with_retry(batch, batch_count)
                except Exception as exc:
                    logger.error(
                        "Failed to commit final batch of existing issues to Firestore",
                        extra={
                            "error": str(exc),
                            "batch_size": batch_count,
                            "total_written": total_written,
                            "total_updated": total_updated,
                        },
                        exc_info=True,
                    )
                    raise
                if progress_callback:
                    try:
                        original_total = len(issue_doc_pairs)
                        # Writing is 90% of work (checking was 10%), so progress = 10% + (written/total * 90%)
                        written_progress = ((total_written + total_updated) / original_total * 90.0) if original_total > 0 else 0.0
                        progress_callback(total_written + total_updated, original_total, 10.0 + written_progress)
                    except Exception:
                        pass
                batch = None
            
            # If we skipped the existence check, determine new vs existing by checking first_seen_in_run
            if skipped_check:
                # Get run_id from issues (all should have the same run_id)
                run_id = None
                for _, issue in issue_doc_pairs:
                    if "run_id" in issue:
                        run_id = issue["run_id"]
                        break
                
                if run_id:
                    # For large batches, use sampling instead of reading all documents
                    LARGE_BATCH_THRESHOLD = 10000
                    USE_SAMPLING = len(all_doc_ids) > LARGE_BATCH_THRESHOLD
                    
                    if USE_SAMPLING:
                        # Use statistical sampling for large batches
                        sample_size = min(2000, len(all_doc_ids))
                        sample_doc_ids = random.sample(all_doc_ids, sample_size)
                        
                        def check_sample_documents() -> int:
                            """Check sample documents and return count of new issues."""
                            sample_new = 0
                            check_chunk_size = 500
                            
                            for i in range(0, len(sample_doc_ids), check_chunk_size):
                                chunk_doc_ids = sample_doc_ids[i:i + check_chunk_size]
                                chunk_doc_refs = [collection_ref.document(doc_id) for doc_id in chunk_doc_ids]
                                chunk_docs = client.get_all(chunk_doc_refs)
                                
                                for doc in chunk_docs:
                                    if doc.exists:
                                        doc_data = doc.to_dict()
                                        if doc_data.get("first_seen_in_run") == run_id:
                                            sample_new += 1
                                
                                # Log progress during sampling
                                if progress_callback:
                                    try:
                                        checked = min(i + check_chunk_size, len(sample_doc_ids))
                                        sample_progress = (checked / len(sample_doc_ids)) * 100.0
                                        progress_callback(
                                            len(all_doc_ids),
                                            len(all_doc_ids),
                                            95.0 + (sample_progress * 0.05)  # Last 5% of progress
                                        )
                                    except Exception:
                                        pass
                            
                            return sample_new
                        
                        try:
                            # Use timeout protection for post-write check (60 seconds)
                            # IMPORTANT: Don't use 'with' context manager to avoid hanging on timeout
                            executor = ThreadPoolExecutor(max_workers=1)
                        except Exception as exc:
                            logger.warning(f"Failed to create executor: {exc}")
                            total_new_issues = int(len(all_doc_ids) * 0.8)
                        else:
                            try:
                                future = executor.submit(check_sample_documents)
                                sample_new_count = future.result(timeout=60)

                                # Extrapolate from sample
                                new_ratio = sample_new_count / sample_size if sample_size > 0 else 0.0
                                total_new_issues = int(new_ratio * len(all_doc_ids))

                                # Calculate confidence interval (95% confidence)
                                # Using normal approximation for binomial distribution
                                p = new_ratio
                                n = sample_size
                                z = 1.96  # 95% confidence
                                margin = z * math.sqrt((p * (1 - p)) / n) if n > 0 else 0
                                lower_bound = max(0, int((p - margin) * len(all_doc_ids)))
                                upper_bound = min(len(all_doc_ids), int((p + margin) * len(all_doc_ids)))

                                logger.info(
                                    f"Estimated new issues from sample: {total_new_issues}/{len(all_doc_ids)} "
                                    f"(95% CI: {lower_bound}-{upper_bound}, sample: {sample_new_count}/{sample_size})",
                                    extra={
                                        "run_id": run_id,
                                        "method": "sampling",
                                        "sample_size": sample_size,
                                        "sample_new": sample_new_count,
                                        "estimated_new": total_new_issues,
                                        "total": len(all_doc_ids),
                                        "confidence_interval": [lower_bound, upper_bound],
                                    }
                                )
                            except FuturesTimeoutError:
                                logger.warning(
                                    "Post-write check timed out after 60 seconds, using estimate",
                                    extra={"run_id": run_id, "total_issues": len(all_doc_ids)},
                                )
                                total_new_issues = int(len(all_doc_ids) * 0.8)  # Conservative estimate: 80% new
                            except Exception as exc:
                                logger.warning(
                                    "Failed to count new issues after writing, using estimate",
                                    extra={"error": str(exc), "run_id": run_id, "total_issues": len(all_doc_ids)},
                                )
                                total_new_issues = int(len(all_doc_ids) * 0.8)  # Conservative estimate: 80% new
                            finally:
                                # Immediately shutdown executor without waiting for background thread
                                # This prevents hanging when the check times out
                                executor.shutdown(wait=False, cancel_futures=True)
                    else:
                        # For smaller batches, read all documents
                        def check_all_documents() -> int:
                            """Check all documents and return count of new issues."""
                            total_new = 0
                            check_chunk_size = 500
                            
                            for i in range(0, len(all_doc_ids), check_chunk_size):
                                chunk_doc_ids = all_doc_ids[i:i + check_chunk_size]
                                chunk_doc_refs = [collection_ref.document(doc_id) for doc_id in chunk_doc_ids]
                                chunk_docs = client.get_all(chunk_doc_refs)
                                
                                for doc in chunk_docs:
                                    if doc.exists:
                                        doc_data = doc.to_dict()
                                        if doc_data.get("first_seen_in_run") == run_id:
                                            total_new += 1
                                
                                # Log progress during check
                                if progress_callback:
                                    try:
                                        checked = min(i + check_chunk_size, len(all_doc_ids))
                                        check_progress = (checked / len(all_doc_ids)) * 100.0
                                        progress_callback(
                                            len(all_doc_ids),
                                            len(all_doc_ids),
                                            95.0 + (check_progress * 0.05)  # Last 5% of progress
                                        )
                                    except Exception:
                                        pass
                            
                            return total_new
                        
                        try:
                            # Use timeout protection (60 seconds)
                            # IMPORTANT: Don't use 'with' context manager to avoid hanging on timeout
                            executor = ThreadPoolExecutor(max_workers=1)
                        except Exception as exc:
                            logger.warning(f"Failed to create executor: {exc}")
                            total_new_issues = int(len(all_doc_ids) * 0.8)
                        else:
                            try:
                                future = executor.submit(check_all_documents)
                                total_new_issues = future.result(timeout=60)

                                logger.info(
                                    f"Counted new issues after writing: {total_new_issues}/{len(all_doc_ids)}",
                                    extra={"run_id": run_id, "method": "full_check"}
                                )
                            except FuturesTimeoutError:
                                logger.warning(
                                    "Post-write check timed out after 60 seconds, using estimate",
                                    extra={"run_id": run_id, "total_issues": len(all_doc_ids)},
                                )
                                total_new_issues = int(len(all_doc_ids) * 0.8)  # Conservative estimate: 80% new
                            except Exception as exc:
                                logger.warning(
                                    "Failed to count new issues after writing, using estimate",
                                    extra={"error": str(exc), "run_id": run_id, "total_issues": len(all_doc_ids)},
                                )
                                total_new_issues = int(len(all_doc_ids) * 0.8)  # Conservative estimate: 80% new
                            finally:
                                # Immediately shutdown executor without waiting for background thread
                                # This prevents hanging when the check times out
                                executor.shutdown(wait=False, cancel_futures=True)
                else:
                    # No run_id, can't determine - estimate
                    total_new_issues = int(len(all_doc_ids) * 0.8)
                    logger.warning("No run_id in issues, cannot accurately count new vs existing")
            
            logger.info(
                "Recorded issues to Firestore",
                extra={
                    "collection": self._config.issues_collection,
                    "new_issues": total_new_issues,
                    "updated_existing": total_updated if not skipped_check else (len(issue_doc_pairs) - total_new_issues),
                    "total_processed": len(issue_doc_pairs),
                    "new_written": total_written,
                    "skipped_check": skipped_check,
                },
            )
            
            # Return counts: (new_issues_count, total_issues_count)
            return (total_new_issues, len(issue_doc_pairs))
        except Exception as exc:
            logger.error(
                "Failed to record issues",
                extra={"error": str(exc), "issue_count": len(issues)},
                exc_info=True,
            )
            raise

    def record_flagged_rule(self, rule_id: str, data: Dict[str, Any]) -> None:
        """Write a flagged rule to Firestore integrity_flagged_rules collection.
        
        Args:
            rule_id: Rule identifier (used as document ID)
            data: Rule data dictionary
        """
        try:
            client = self._get_client()
            collection_ref = client.collection("integrity_flagged_rules")
            doc_ref = collection_ref.document(rule_id)
            
            rule_data = data.copy()
            if "updated_at" not in rule_data:
                rule_data["updated_at"] = datetime.now(timezone.utc)
            
            doc_ref.set(rule_data, merge=True)
            logger.info(
                "Recorded flagged rule",
                extra={"collection": "integrity_flagged_rules", "rule_id": rule_id},
            )
        except Exception as exc:
            logger.error(
                "Failed to record flagged rule",
                extra={"rule_id": rule_id, "error": str(exc)},
                exc_info=True,
            )
            raise

    def record_kpi_sample(self, week_id: str, data: Dict[str, Any]) -> None:
        """Write KPI sample data to Firestore integrity_kpi_samples collection.
        
        Args:
            week_id: Week identifier (YYYY-WW format, used as document ID)
            data: KPI sample data dictionary
        """
        try:
            client = self._get_client()
            collection_ref = client.collection("integrity_kpi_samples")
            doc_ref = collection_ref.document(week_id)
            
            sample_data = data.copy()
            if "updated_at" not in sample_data:
                sample_data["updated_at"] = datetime.now(timezone.utc)
            
            doc_ref.set(sample_data, merge=True)
            logger.info(
                "Recorded KPI sample",
                extra={"collection": "integrity_kpi_samples", "week_id": week_id},
            )
        except Exception as exc:
            logger.error(
                "Failed to record KPI sample",
                extra={"week_id": week_id, "error": str(exc)},
                exc_info=True,
            )
            raise

    def record_run_log(self, run_id: str, level: str, message: str, metadata: Optional[Dict[str, Any]] = None) -> None:
        """Write a log entry to Firestore integrity_runs/{run_id}/logs subcollection.
        
        Args:
            run_id: Run identifier
            level: Log level (info, warning, error, debug)
            message: Log message
            metadata: Optional additional metadata
        """
        try:
            client = self._get_client()
            run_ref = client.collection(self._config.runs_collection).document(run_id)
            logs_ref = run_ref.collection("logs")
            
            log_data: Dict[str, Any] = {
                "level": level,
                "message": message,
                "timestamp": datetime.now(timezone.utc),
            }
            if metadata:
                log_data.update(metadata)
            
            # Use auto-generated document ID (Firestore will create unique ID)
            logs_ref.add(log_data)
            
            logger.debug(
                "Recorded run log",
                extra={"run_id": run_id, "level": level, "message": message[:100]},
            )
        except Exception as exc:
            # Don't fail the scan if logging fails - just log to console
            logger.warning(
                "Failed to record run log",
                extra={"run_id": run_id, "error": str(exc)},
            )
    
    def delete_run(self, run_id: str) -> None:
        """Delete a run and all its associated logs from Firestore.
        
        Args:
            run_id: Run identifier to delete
        """
        try:
            client = self._get_client()
            run_ref = client.collection(self._config.runs_collection).document(run_id)
            
            # Delete all logs in the logs subcollection
            logs_ref = run_ref.collection("logs")
            logs = logs_ref.stream()
            batch = client.batch()
            batch_count = 0
            
            for log_doc in logs:
                batch.delete(log_doc.reference)
                batch_count += 1
                
                # Firestore batch limit is 500 operations
                if batch_count >= 500:
                    batch.commit()
                    batch = client.batch()
                    batch_count = 0
            
            # Commit remaining log deletions
            if batch_count > 0:
                batch.commit()
            
            # Delete the run document itself
            run_ref.delete()
            
            logger.info(
                "Deleted run and associated logs",
                extra={"run_id": run_id, "collection": self._config.runs_collection},
            )
        except Exception as exc:
            logger.error(
                "Failed to delete run",
                extra={"run_id": run_id, "error": str(exc)},
                exc_info=True,
            )
            raise
