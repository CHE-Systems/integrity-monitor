"""Factory for fetcher instances."""

from __future__ import annotations

from typing import Dict, Optional, TYPE_CHECKING

from ..clients.airtable import AirtableClient
from .base import BaseFetcher

if TYPE_CHECKING:
    from ..services.school_year_service import SchoolYearService

ENTITY_KEYS = [
    "contractors",
    "students",
    "parents",
    "absent",
    "student_truth",
    "classes",
    "transfers",
    "invoices",
]


def build_fetchers(
    client: AirtableClient,
    school_year_service: Optional["SchoolYearService"] = None
) -> Dict[str, BaseFetcher]:
    """Build fetchers for all entities with optional school year filtering.

    Args:
        client: AirtableClient instance
        school_year_service: Optional SchoolYearService for automatic filtering

    Returns:
        Dictionary mapping entity keys to BaseFetcher instances
    """
    return {
        key: BaseFetcher(client, key, school_year_service)
        for key in ENTITY_KEYS
    }
