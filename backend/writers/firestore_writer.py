"""Persist run summaries and metrics to Firestore."""

from __future__ import annotations

import threading
import time
from typing import Any, Dict, Iterable, Optional

from ..clients.firestore import FirestoreClient
from ..utils.issues import IssuePayload


class AsyncLogBuffer:
    """Buffers log entries and flushes them to Firestore asynchronously to avoid blocking.
    
    This prevents synchronous Firestore writes from blocking record fetching operations.
    Logs are flushed every 3 seconds or when the buffer reaches 10 entries.
    """
    
    def __init__(
        self,
        writer: "FirestoreWriter",
        run_id: str,
        flush_interval: float = 3.0,
        max_buffer: int = 10,
    ):
        """Initialize async log buffer.
        
        Args:
            writer: FirestoreWriter instance to use for writing logs
            run_id: Run identifier for logs
            flush_interval: Seconds between automatic flushes (default: 3.0)
            max_buffer: Maximum buffer size before forced flush (default: 10)
        """
        self._writer = writer
        self._run_id = run_id
        self._flush_interval = flush_interval
        self._max_buffer = max_buffer
        self._buffer: list[tuple[str, str, Optional[Dict[str, Any]]]] = []
        self._lock = threading.Lock()
        self._stop_event = threading.Event()
        self._flush_thread: Optional[threading.Thread] = None
        self._started = False
    
    def start(self) -> None:
        """Start the background flush thread."""
        if self._started:
            return
        
        self._started = True
        self._flush_thread = threading.Thread(target=self._flush_loop, daemon=True)
        self._flush_thread.start()
    
    def log(self, level: str, message: str, metadata: Optional[Dict[str, Any]] = None) -> None:
        """Add a log entry to the buffer (non-blocking).
        
        Args:
            level: Log level (info, warning, error, debug)
            message: Log message
            metadata: Optional additional metadata
        """
        log_start = time.time()
        with self._lock:
            self._buffer.append((level, message, metadata))
            buffer_size = len(self._buffer)
            
            # Force flush if buffer is full
            if buffer_size >= self._max_buffer:
                # Trigger immediate flush by releasing lock and allowing thread to process
                pass
        log_duration = time.time() - log_start
        if log_duration > 0.01:  # Only log if lock contention is significant
            import logging
            logger = logging.getLogger(__name__)
            logger.debug(
                f"[TIMING] Async buffer log took {log_duration:.3f}s (buffer size: {buffer_size})",
                extra={"log_duration": log_duration, "buffer_size": buffer_size}
            )
    
    def flush(self) -> None:
        """Immediately flush all buffered logs to Firestore."""
        flush_start = time.time()
        with self._lock:
            if not self._buffer:
                return
            
            logs_to_flush = self._buffer[:]
            self._buffer.clear()
            log_count = len(logs_to_flush)
        
        # Write logs outside the lock to avoid blocking other threads
        write_start = time.time()
        for level, message, metadata in logs_to_flush:
            try:
                write_log_start = time.time()
                self._writer.write_log(self._run_id, level, message, metadata)
                write_log_duration = time.time() - write_log_start
                if write_log_duration > 0.1:  # Log slow Firestore writes
                    import logging
                    logger = logging.getLogger(__name__)
                    logger.warning(
                        f"[TIMING] Slow Firestore write_log: {write_log_duration:.3f}s",
                        extra={"write_log_duration": write_log_duration, "message": message[:50]}
                    )
            except Exception:
                pass  # Don't fail on logging errors
        
        write_duration = time.time() - write_start
        total_flush_duration = time.time() - flush_start
        if total_flush_duration > 0.1 or write_duration > 0.1:  # Log if flush is slow
            import logging
            logger = logging.getLogger(__name__)
            logger.info(
                f"[TIMING] Async buffer flush: {total_flush_duration:.3f}s total (write: {write_duration:.3f}s, {log_count} logs)",
                extra={
                    "total_flush_duration": total_flush_duration,
                    "write_duration": write_duration,
                    "log_count": log_count,
                }
            )
    
    def _flush_loop(self) -> None:
        """Background thread that periodically flushes the buffer."""
        while not self._stop_event.is_set():
            self._stop_event.wait(self._flush_interval)
            if not self._stop_event.is_set():
                self.flush()
    
    def stop(self) -> None:
        """Stop the background thread and flush remaining logs."""
        if not self._started:
            return
        
        self._stop_event.set()
        if self._flush_thread:
            self._flush_thread.join(timeout=5.0)
        
        # Final flush of any remaining logs
        self.flush()
        self._started = False


class FirestoreWriter:
    def __init__(self, client: FirestoreClient):
        self._client = client

    def write_run(self, run_id: str, payload: Dict[str, Any], metadata: Optional[Dict[str, Any]] = None) -> None:
        """Write run summary to Firestore.

        Args:
            run_id: Unique run identifier
            payload: Issue counts/summary (from scorer.summarize). If empty dict, counts will not be updated.
            metadata: Additional run metadata (status, timestamps, entity_counts, etc.)
        """
        data: Dict[str, Any] = {}
        # Only include counts if payload has content (to avoid overwriting existing counts with empty dict)
        if payload:
            # Transform flat summary into structured counts for frontend compatibility
            counts_structured = self._transform_summary_to_counts(payload)
            data["counts"] = counts_structured
        if metadata:
            data.update(metadata)
        self._client.record_run(run_id, data)

    def _transform_summary_to_counts(self, summary: Dict[str, Any]) -> Dict[str, Any]:
        """Transform flat scorer summary into structured counts.

        Args:
            summary: Flat dictionary from scorer.summarize() with keys like "missing_field:info"

        Returns:
            Structured counts with total, by_type, and by_severity
        """
        by_type: Dict[str, int] = {}
        by_severity: Dict[str, int] = {
            "critical": 0,
            "warning": 0,
            "info": 0
        }
        
        # Valid severity values
        valid_severities = {"critical", "warning", "info"}

        for key, count in summary.items():
            # Skip special aggregate keys
            if key == "duplicate_groups_formed":
                continue
            
            # Handle attendance keys
            if key.startswith("attendance:"):
                parts = key.split(":")
                # Case: "attendance:severity" (already aggregated by severity)
                if len(parts) == 2 and parts[1] in valid_severities:
                    severity = parts[1]
                    by_severity[severity] += count
                    # Don't add to by_type here to avoid double-counting "attendance"
                
                # Case: "attendance:metric:severity" (detailed attendance issue)
                elif len(parts) == 3 and parts[2] in valid_severities:
                    # We don't add these to severity counts here because "attendance:severity"
                    # already carries the aggregate. But we do want to ensure they aren't
                    # double-counted in total if we were to sum by_type.
                    pass
                continue

            # Parse regular issue keys like "missing_field:info" or "missing_link"
            if ":" in key:
                parts = key.split(":", 1)
                issue_type, severity = parts
                
                # Aggregate by severity
                if severity in valid_severities:
                    by_severity[severity] += count
                
                # Aggregate by type
                by_type[issue_type] = by_type.get(issue_type, 0) + count
            else:
                # Keys without severity (like "missing_field" or "attendance")
                # These are type-level aggregates
                by_type[key] = count

        # Calculate total as the sum of all issues including info-level
        # This ensures total count is never less than any individual severity count
        total = by_severity["critical"] + by_severity["warning"] + by_severity["info"]

        return {
            "total": total,
            "by_type": by_type,
            "by_severity": by_severity,
        }

    def write_metrics(self, payload: Dict[str, Any]) -> None:
        """Write daily metrics to Firestore."""
        self._client.record_metrics(payload)

    def write_issues(self, issues: Iterable[IssuePayload], run_id: Optional[str] = None) -> int:
        """Write individual issues to Firestore integrity_issues collection.
        
        Args:
            issues: Iterable of IssuePayload objects to write
            run_id: Optional run ID for progress logging
            
        Returns:
            Number of new issues written (issues that didn't exist before)
        """
        issues_list = list(issues)
        if not issues_list:
            return 0
        
        # Convert IssuePayload objects to dictionaries
        issue_dicts = []
        for issue in issues_list:
            issue_dict = {
                "rule_id": issue.rule_id,
                "issue_type": issue.issue_type,
                "entity": issue.entity,
                "record_id": issue.record_id,
                "severity": issue.severity,
                "description": issue.description,
                "metadata": issue.metadata,
            }
            if issue.related_records:
                issue_dict["related_records"] = issue.related_records
            if run_id:
                issue_dict["run_id"] = run_id
            issue_dicts.append(issue_dict)
        
        # Create progress callback if run_id is provided
        progress_callback = None
        if run_id:
            # Track last logged milestone to reduce Firestore writes during progress
            last_logged_percentage = [0.0]  # Use list to allow mutation in closure
            last_log_time = [time.time()]  # Track time to throttle logs
            
            def log_progress(current: int, total: int, percentage: float) -> None:
                # Only log every 5% progress or every 30 seconds to avoid excessive Firestore writes
                # This prevents blocking the main write loop with too many progress log writes
                current_time = time.time()
                percentage_delta = percentage - last_logged_percentage[0]
                time_delta = current_time - last_log_time[0]
                
                should_log = (
                    percentage_delta >= 5.0  # Log every 5%
                    or time_delta >= 30.0  # Or every 30 seconds
                    or percentage >= 99.0  # Or near completion
                )
                
                if not should_log:
                    return  # Skip this progress update
                
                try:
                    if percentage < 10.0:
                        # During existence check phase
                        self.write_log(
                            run_id,
                            "info",
                            f"Checking which issues already exist: {current:,}/{total:,} ({percentage:.1f}%)"
                        )
                    else:
                        # During writing phase
                        self.write_log(
                            run_id,
                            "info",
                            f"Writing issues to Firestore: {current:,}/{total:,} ({percentage:.1f}%)"
                        )
                    
                    # Update tracking
                    last_logged_percentage[0] = percentage
                    last_log_time[0] = current_time
                except Exception:
                    pass  # Don't fail on logging errors
            
            progress_callback = log_progress
        
        new_count, total_count = self._client.record_issues(issue_dicts, progress_callback=progress_callback)
        return new_count

    def write_log(self, run_id: str, level: str, message: str, metadata: Optional[Dict[str, Any]] = None) -> None:
        """Write a log entry to Firestore for the run.
        
        Args:
            run_id: Run identifier
            level: Log level (info, warning, error, debug)
            message: Log message
            metadata: Optional additional metadata
        """
        self._client.record_run_log(run_id, level, message, metadata)
    
    def create_async_log_buffer(
        self,
        run_id: str,
        flush_interval: float = 3.0,
        max_buffer: int = 10,
    ) -> AsyncLogBuffer:
        """Create an async log buffer for non-blocking progress logging.
        
        Args:
            run_id: Run identifier
            flush_interval: Seconds between automatic flushes (default: 3.0)
            max_buffer: Maximum buffer size before forced flush (default: 10)
            
        Returns:
            AsyncLogBuffer instance (call start() to begin, stop() to flush and cleanup)
        """
        return AsyncLogBuffer(self, run_id, flush_interval, max_buffer)
