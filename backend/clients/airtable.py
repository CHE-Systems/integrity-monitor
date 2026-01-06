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
            pat = os.getenv("AIRTABLE_PAT")
            
            if not pat:
                raise ValueError(
                    "AIRTABLE_PAT environment variable must be set"
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
        base_id = os.getenv(table_cfg.base_env)
        table_id = os.getenv(table_cfg.table_env)

        if not base_id:
            raise ValueError(
                f"Environment variable {table_cfg.base_env} not set (required for {key})"
            )
        if not table_id:
            raise ValueError(
                f"Environment variable {table_cfg.table_env} not set (required for {key})"
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

    @retry(
        retry=retry_if_exception_type((HTTPError, RequestException)),
        stop=(stop_after_attempt(3) | stop_after_delay(API_TIMEOUT_SECONDS)),
        wait=wait_exponential(multiplier=1, min=1, max=10),
        reraise=True,
    )
    def _fetch_with_retry(
        self,
        key: str,
        base_id: str,
        table_id: str,
        progress_callback: Optional[Callable[[str, Optional[Dict[str, Any]]], None]] = None,
        cancel_check: Optional[Callable[[], None]] = None,
    ) -> List[Dict[str, Any]]:
        """Fetch records with retry logic and rate limiting.

        Args:
            key: Entity key (e.g., "students", "parents")
            base_id: Airtable base ID
            table_id: Airtable table ID
            progress_callback: Optional callback function(message, metadata) called during pagination
            cancel_check: Optional callback that raises an exception if the operation should be cancelled
        """
        self._throttle_request(base_id)

        api = self._get_api()
        table = api.table(base_id, table_id)

        logger.info(
            "Fetching Airtable records",
            extra={
                "entity": key,
                "base": base_id,
                "table": table_id,
            },
        )

        # Fetch all records with pagination, throttling between pages
        records = []
        page_count = 0
        total_records = 0
        fetch_start_time = time.time()
        
        try:
            # Use iterate() directly so we can throttle between pages
            for page in table.iterate(page_size=100):
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
    ) -> List[Dict[str, Any]]:
        """Fetch records for the given logical entity.

        Args:
            key: Entity key (e.g., "students", "parents")
            progress_callback: Optional callback function(message, metadata) called during pagination
            cancel_check: Optional callback that raises an exception if the operation should be cancelled

        Returns:
            List of record dictionaries
        """
        table_meta = self._resolve_table(key)
        base_id = table_meta["base_id"]
        table_id = table_meta["table_id"]

        try:
            return self._fetch_with_retry(key, base_id, table_id, progress_callback, cancel_check)
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
