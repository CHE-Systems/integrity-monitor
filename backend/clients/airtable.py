"""Airtable client wrapper used by fetchers."""

from __future__ import annotations

import logging
import os
import time
from collections import defaultdict
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional

from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    stop_after_delay,
    wait_exponential,
)

# Constants
MIN_REQUEST_INTERVAL = float(os.getenv("AIRTABLE_MIN_REQUEST_INTERVAL", "0.05"))  # Seconds between requests (0.05s = 20 req/s max, safe for parallel workers)
API_TIMEOUT_SECONDS = int(os.getenv("AIRTABLE_API_TIMEOUT_SECONDS", "30"))  # Timeout for retries
# Socket-level timeout for large record fetches (~10k records per entity)
REQUEST_TIMEOUT_SECONDS = int(os.getenv("AIRTABLE_REQUEST_TIMEOUT_SECONDS", "300"))  # 5 minutes default
# Progress logging interval (log every N pages or every 500 records)
PROGRESS_LOG_INTERVAL = int(os.getenv("AIRTABLE_PROGRESS_LOG_INTERVAL", "5"))  # Log every 5 pages

try:
    from pyairtable import Api
    from requests.exceptions import HTTPError, RequestException
except ImportError:
    Api = None
    HTTPError = Exception
    RequestException = Exception

from ..config.settings import AirtableConfig
from ..utils.secrets import get_secret

logger = logging.getLogger(__name__)




class AirtableClient:
    """Thin wrapper around pyairtable with retry/rate limiting support."""

    def __init__(self, config: AirtableConfig):
        self._config = config
        self._last_request_time: Dict[str, float] = defaultdict(float)
        self._api: Optional[Api] = None

    def _get_api(self) -> Api:
        """Lazy initialization of pyairtable API client."""
        if self._api is None:
            if Api is None:
                raise ImportError(
                    "pyairtable not installed. Install with: pip install pyairtable"
                )
            # Use Personal Access Token (PAT) for Airtable authentication
            # Try environment variable first, then Secret Manager for local development
            pat = get_secret("AIRTABLE_PAT")
            
            if not pat:
                raise ValueError(
                    "AIRTABLE_PAT not found in environment variables or Secret Manager. "
                    "Set AIRTABLE_PAT environment variable or ensure it exists in Google Cloud Secret Manager."
                )
            
            token = pat

            # Configure socket timeout: (connect_timeout, read_timeout)
            # Both set to REQUEST_TIMEOUT_SECONDS to prevent hanging on network issues
            timeout = (REQUEST_TIMEOUT_SECONDS, REQUEST_TIMEOUT_SECONDS)
            self._api = Api(token, timeout=timeout)
            logger.info(f"Initialized Airtable API with {REQUEST_TIMEOUT_SECONDS}s socket timeout")
        return self._api

    def _resolve_table(self, key: str) -> Dict[str, str]:
        """Resolve table configuration with validation."""
        table_cfg = self._config.table(key)
        # Try environment variable first, then Secret Manager for local development
        base_id = get_secret(table_cfg.base_env)
        table_id = get_secret(table_cfg.table_env)

        if not base_id:
            raise ValueError(
                f"{table_cfg.base_env} not found in environment variables or Secret Manager (required for {key})"
            )
        if not table_id:
            raise ValueError(
                f"{table_cfg.table_env} not found in environment variables or Secret Manager (required for {key})"
            )

        return {
            "base_id": base_id,
            "table_id": table_id,
        }

    def _throttle_request(self, base_id: str) -> None:
        """Throttle requests to respect rate limits."""
        throttle_start = time.time()
        now = time.time()
        last_time = self._last_request_time[base_id]
        elapsed = now - last_time
        
        if elapsed < MIN_REQUEST_INTERVAL:
            sleep_time = MIN_REQUEST_INTERVAL - elapsed
            logger.debug(
                f"Throttling request: sleeping {sleep_time:.3f}s (elapsed: {elapsed:.3f}s, min_interval: {MIN_REQUEST_INTERVAL}s)",
                extra={"base_id": base_id, "sleep_time": sleep_time, "elapsed": elapsed}
            )
            time.sleep(sleep_time)
        
        self._last_request_time[base_id] = time.time()
        throttle_duration = time.time() - throttle_start
        if throttle_duration > 0.01:  # Only log if significant
            logger.debug(
                f"Throttle completed in {throttle_duration:.3f}s",
                extra={"base_id": base_id, "throttle_duration": throttle_duration}
            )

    def build_school_year_filter(
        self,
        field_name: str,
        active_years: List[str],
        filter_type: str = "exact"
    ) -> str:
        """Build Airtable formula to filter by school years.

        Args:
            field_name: Name of the school year field in Airtable
            active_years: List of school year strings (e.g., ["2024-2025", "2025-2026"])
            filter_type: Either "exact" for direct equality or "contains" for substring search

        Returns:
            Airtable formula string for filtering

        Examples:
            exact: {School Year}="2024-2025"
            exact (multiple): OR({School Year}="2024-2025", {School Year}="2025-2026")
            contains: FIND("2024-2025", {School Year (from Student) text})
            contains (multiple): OR(FIND("2024-2025", {Field}), FIND("2025-2026", {Field}))
        """
        if not active_years:
            return ""

        # Escape field name with curly braces for Airtable formula
        field_ref = f"{{{field_name}}}"

        if filter_type == "exact":
            # For direct equality comparisons
            if len(active_years) == 1:
                return f"{field_ref}='{active_years[0]}'"
            else:
                conditions = [f"{field_ref}='{year}'" for year in active_years]
                return f"OR({', '.join(conditions)})"
        elif filter_type == "contains":
            # For lookup/concatenated fields, use FIND() to check if year exists in string
            if len(active_years) == 1:
                return f"FIND('{active_years[0]}', {field_ref})"
            else:
                conditions = [f"FIND('{year}', {field_ref})" for year in active_years]
                return f"OR({', '.join(conditions)})"
        else:
            raise ValueError(f"Invalid filter_type: {filter_type}. Must be 'exact' or 'contains'")

    @retry(
        retry=retry_if_exception_type((HTTPError, RequestException)),
        stop=(stop_after_attempt(5) | stop_after_delay(API_TIMEOUT_SECONDS * 2)),  # More retries for 504 errors
        wait=wait_exponential(multiplier=2, min=2, max=30),  # Longer waits for gateway timeouts
        reraise=True,
    )
    def _fetch_with_retry(
        self,
        key: str,
        base_id: str,
        table_id: str,
        progress_callback: Optional[Callable[[str, Optional[Dict[str, Any]]], None]] = None,
        cancel_check: Optional[Callable[[], None]] = None,
        filter_formula: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """Fetch records with retry logic and rate limiting.

        Args:
            key: Entity key (e.g., "students", "parents")
            base_id: Airtable base ID
            table_id: Airtable table ID
            progress_callback: Optional callback function(message, metadata) called during pagination
            cancel_check: Optional callback that raises an exception if the operation should be cancelled
            filter_formula: Optional Airtable formula string for filtering records
        """
        self._throttle_request(base_id)

        api = self._get_api()
        table = api.table(base_id, table_id)

        log_extra = {
            "entity": key,
            "base": base_id,
            "table": table_id,
        }
        if filter_formula:
            log_extra["filter"] = filter_formula
            logger.info(f"Fetching Airtable records with filter: {filter_formula}", extra=log_extra)
        else:
            logger.info("Fetching Airtable records", extra=log_extra)

        # Fetch all records with pagination, throttling between pages
        records = []
        page_count = 0
        total_records = 0
        fetch_start_time = time.time()

        try:
            # Use iterate() directly so we can throttle between pages
            # If filter_formula is provided, pass it to iterate()
            iterate_kwargs = {"page_size": 100}
            if filter_formula:
                iterate_kwargs["formula"] = filter_formula

            for page in table.iterate(**iterate_kwargs):
                # Check for cancellation/timeout at the start of each page
                if cancel_check:
                    try:
                        cancel_check()
                    except Exception:
                        logger.info(
                            "Fetch cancelled during pagination",
                            extra={"entity": key, "pages_fetched": page_count, "records_fetched": total_records}
                        )
                        raise

                page_start_time = time.time()

                # Time the actual page fetch from Airtable
                page_fetch_start = time.time()
                records.extend(page)
                total_records += len(page)
                page_count += 1
                page_fetch_duration = time.time() - page_fetch_start
                
                logger.info(
                    f"[TIMING] Page {page_count} fetch: {page_fetch_duration:.3f}s ({len(page)} records)",
                    extra={
                        "entity": key,
                        "page": page_count,
                        "records_in_page": len(page),
                        "total_records": total_records,
                        "page_fetch_duration": page_fetch_duration,
                    }
                )
                
                # Throttle between pages (first page already throttled above)
                throttle_start = time.time()
                if page_count > 1:
                    self._throttle_request(base_id)
                throttle_duration = time.time() - throttle_start
                if throttle_duration > 0.01:
                    logger.info(
                        f"[TIMING] Page {page_count} throttle: {throttle_duration:.3f}s",
                        extra={
                            "entity": key,
                            "page": page_count,
                            "throttle_duration": throttle_duration,
                        }
                    )
                
                # Call progress callback if provided
                callback_start = time.time()
                if progress_callback:
                    try:
                        progress_callback(
                            f"Fetched page {page_count}, {total_records} records so far",
                            {"pages": page_count, "records": total_records, "entity": key}
                        )
                    except Exception:
                        pass  # Don't fail on callback errors
                callback_duration = time.time() - callback_start
                
                page_total_duration = time.time() - page_start_time
                logger.info(
                    f"[TIMING] Page {page_count} total: {page_total_duration:.3f}s (fetch: {page_fetch_duration:.3f}s, throttle: {throttle_duration:.3f}s, callback: {callback_duration:.3f}s)",
                    extra={
                        "entity": key,
                        "page": page_count,
                        "page_total_duration": page_total_duration,
                        "page_fetch_duration": page_fetch_duration,
                        "throttle_duration": throttle_duration,
                        "callback_duration": callback_duration,
                    }
                )
                
                # Log progress periodically (for console logs)
                if page_count % PROGRESS_LOG_INTERVAL == 0 or total_records % 500 == 0:
                    logger.info(
                        f"Fetched {page_count} page(s), {total_records} records so far",
                        extra={
                            "entity": key,
                            "pages": page_count,
                            "records": total_records,
                            "base": base_id,
                            "table": table_id,
                        }
                    )

            # Call completion callback
            if progress_callback:
                try:
                    progress_callback(
                        f"Completed fetching {total_records} records in {page_count} pages",
                        {"pages": page_count, "records": total_records, "entity": key}
                    )
                except Exception:
                    pass

            total_fetch_duration = time.time() - fetch_start_time
            avg_time_per_page = total_fetch_duration / page_count if page_count > 0 else 0
            logger.info(
                f"Fetched Airtable records successfully: {total_fetch_duration:.3f}s total ({avg_time_per_page:.3f}s avg per page)",
                extra={
                    "entity": key,
                    "record_count": len(records),
                    "pages": page_count,
                    "total_fetch_duration": total_fetch_duration,
                    "avg_time_per_page": avg_time_per_page,
                },
            )

        except HTTPError as exc:
            # Special handling for 504 Gateway Timeout - these are often transient
            if exc.response is not None and exc.response.status_code == 504:
                logger.warning(
                    "Airtable Gateway Timeout (504) - this may be transient, retries will be attempted",
                    extra={
                        "entity": key,
                        "base": base_id,
                        "table": table_id,
                        "pages_fetched": page_count,
                        "records_fetched": total_records,
                        "status_code": 504,
                    },
                )
            else:
                logger.error(
                    "HTTP error fetching from Airtable",
                    extra={
                        "entity": key,
                        "base": base_id,
                        "table": table_id,
                        "status_code": exc.response.status_code if exc.response else None,
                        "error": str(exc),
                        "pages_fetched": page_count,
                        "records_fetched": total_records,
                    },
                    exc_info=True,
                )
            raise
        except Exception as exc:
            logger.error(
                "Error fetching from Airtable",
                extra={
                    "entity": key,
                    "base": base_id,
                    "table": table_id,
                    "error": str(exc),
                    "pages_fetched": page_count,
                    "records_fetched": total_records,
                },
                exc_info=True,
            )
            raise

        return records

    def fetch_records(
        self,
        key: str,
        progress_callback: Optional[Callable[[str, Optional[Dict[str, Any]]], None]] = None,
        cancel_check: Optional[Callable[[], None]] = None,
        filter_formula: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """Fetch records for the given logical entity.

        Args:
            key: Entity key (e.g., "students", "parents")
            progress_callback: Optional callback function(message, metadata) called during pagination
            cancel_check: Optional callback that raises an exception if the operation should be cancelled
            filter_formula: Optional Airtable formula string for filtering records

        Returns:
            List of record dictionaries
        """
        table_meta = self._resolve_table(key)
        base_id = table_meta["base_id"]
        table_id = table_meta["table_id"]

        try:
            return self._fetch_with_retry(key, base_id, table_id, progress_callback, cancel_check, filter_formula)
        except Exception as exc:
            logger.error(
                "Failed to fetch Airtable records after retries",
                extra={"entity": key, "base": base_id, "error": str(exc)},
                exc_info=True,
            )
            raise

    def fetch_records_by_id(
        self,
        base_id: str,
        table_id: str,
        progress_callback: Optional[Callable[[str, Optional[Dict[str, Any]]], None]] = None,
        cancel_check: Optional[Callable[[], None]] = None,
    ) -> List[Dict[str, Any]]:
        """Fetch records directly by base_id and table_id.

        Args:
            base_id: Airtable base ID
            table_id: Airtable table ID
            progress_callback: Optional callback function(message, metadata) called during pagination
            cancel_check: Optional callback that raises an exception if the operation should be cancelled

        Returns:
            List of record dictionaries
        """
        try:
            return self._fetch_with_retry("direct", base_id, table_id, progress_callback, cancel_check)
        except Exception as exc:
            logger.error(
                "Failed to fetch Airtable records by ID",
                extra={"base": base_id, "table": table_id, "error": str(exc)},
                exc_info=True,
            )
            raise
