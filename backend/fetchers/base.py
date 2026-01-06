"""Base fetcher that all entity-specific fetchers can reuse."""

from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional

from ..clients.airtable import AirtableClient


class BaseFetcher:
    def __init__(self, client: AirtableClient, entity_key: str):
        self._client = client
        self._entity_key = entity_key

    def fetch(
        self,
        progress_callback: Optional[Callable[[str, Optional[Dict[str, Any]]], None]] = None,
        cancel_check: Optional[Callable[[], None]] = None,
    ) -> List[Dict[str, Any]]:
        """Fetch all records for the entity.

        Args:
            progress_callback: Optional callback function(message, metadata) called during pagination
            cancel_check: Optional callback that raises an exception if the operation should be cancelled

        Returns:
            List of record dictionaries.
        """
        return self._client.fetch_records(self._entity_key, progress_callback, cancel_check)
