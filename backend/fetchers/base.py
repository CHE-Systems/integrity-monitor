"""Base fetcher that all entity-specific fetchers can reuse."""

from __future__ import annotations

import logging
from typing import Any, Callable, Dict, List, Optional, TYPE_CHECKING

from ..clients.airtable import AirtableClient

if TYPE_CHECKING:
    from ..services.school_year_service import SchoolYearService

logger = logging.getLogger(__name__)


class BaseFetcher:
    def __init__(
        self,
        client: AirtableClient,
        entity_key: str,
        school_year_service: Optional["SchoolYearService"] = None
    ):
        self._client = client
        self._entity_key = entity_key
        self._school_year_service = school_year_service

    def fetch(
        self,
        progress_callback: Optional[Callable[[str, Optional[Dict[str, Any]]], None]] = None,
        cancel_check: Optional[Callable[[], None]] = None,
    ) -> List[Dict[str, Any]]:
        """Fetch all records for the entity with automatic school year filtering.

        Args:
            progress_callback: Optional callback function(message, metadata) called during pagination
            cancel_check: Optional callback that raises an exception if the operation should be cancelled

        Returns:
            List of record dictionaries.
        """
        filter_formula = None

        # Apply school year filtering if service is available
        if self._school_year_service:
            try:
                field_config = self._school_year_service.get_field_config_for_entity(self._entity_key)

                if field_config:
                    field_name = field_config.get("field_name")
                    filter_type = field_config.get("filter_type", "exact")

                    # Get active school years
                    active_years = self._school_year_service.get_active_school_years()

                    if active_years and field_name:
                        # Build filter formula
                        filter_formula = self._client.build_school_year_filter(
                            field_name,
                            active_years,
                            filter_type
                        )

                        logger.info(
                            f"Applying school year filter to {self._entity_key}: {active_years}",
                            extra={
                                "entity": self._entity_key,
                                "active_years": active_years,
                                "field_name": field_name,
                                "filter_type": filter_type,
                                "filter_formula": filter_formula
                            }
                        )
                    else:
                        logger.debug(
                            f"No school year filtering for {self._entity_key}: no active years or field name"
                        )
                else:
                    logger.debug(f"No school year field configured for {self._entity_key}")

            except Exception as e:
                logger.warning(
                    f"Could not apply school year filtering to {self._entity_key}, fetching all records: {e}",
                    exc_info=True
                )

        return self._client.fetch_records(
            self._entity_key,
            progress_callback,
            cancel_check,
            filter_formula
        )
