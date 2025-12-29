"""Factory for fetcher instances."""

from __future__ import annotations

from typing import Dict

from ..clients.airtable import AirtableClient
from .base import BaseFetcher

ENTITY_KEYS = [
    "contractors",
]


def build_fetchers(client: AirtableClient) -> Dict[str, BaseFetcher]:
    return {key: BaseFetcher(client, key) for key in ENTITY_KEYS}
