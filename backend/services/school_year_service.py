"""Service for managing active school year configuration with external API integration."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import List, Optional, Dict, Any
import os
import yaml
from pathlib import Path
import requests

from ..clients.firestore import FirestoreClient


class SchoolYearService:
    """Manages active school year configuration with external API integration.

    Fetches current school year from external API and programmatically generates
    future years (up to 3 years ahead). Always includes current + 3 future years.
    Year transitions are handled externally in the toolkit API.
    """

    CACHE_COLLECTION = "system_config"
    CACHE_DOCUMENT = "active_school_years"

    # External API configuration
    API_BASE_URL = "https://toolkit.che.systems/api/secrets"
    CURRENT_YEAR_SECRET_ID = "yG1S06mVruhx933WDo8r"

    # Number of future years to include beyond current year
    NUM_FUTURE_YEARS = 3

    def __init__(self, firestore_client: FirestoreClient):
        self._firestore = firestore_client

        # Load school_year configuration from rules.yaml
        config_path = Path(__file__).parent.parent / "config" / "rules.yaml"
        with open(config_path, "r") as f:
            config_data = yaml.safe_load(f)
        self._school_year_config = config_data.get("school_year", {})

        # Get API key from Google Cloud Secret Manager (via utils.secrets)
        from ..utils.secrets import get_secret
        self._api_key = get_secret("TOOLKIT_API_KEY")

        if not self._api_key:
            raise ValueError("TOOLKIT_API_KEY not found in environment variables or Secret Manager")

    def get_active_school_years(self, force_refresh: bool = False) -> List[str]:
        """Get list of currently active school years (current + 3 future years).

        Args:
            force_refresh: If True, bypass cache and fetch from API

        Returns:
            List of active school year strings
            Example: ["2025-2026", "2026-2027", "2027-2028", "2028-2029"]
        """
        # Try cache first unless force refresh
        if not force_refresh:
            cached = self._get_cached_years()
            if cached:
                return cached

        # Fetch current year from external API
        current_year = self._fetch_secret(self.CURRENT_YEAR_SECRET_ID)

        if not current_year:
            raise ValueError("Failed to fetch current school year from external API")

        # Generate active years: current + 3 future years
        active_years = self._generate_future_years(current_year, self.NUM_FUTURE_YEARS)

        # Cache the result
        self._cache_years(active_years, current_year)

        return active_years

    def _generate_future_years(self, current_year: str, num_future: int) -> List[str]:
        """Generate future school years programmatically from current year.

        Args:
            current_year: Current school year in format "YYYY-YYYY" (e.g., "2025-2026")
            num_future: Number of future years to generate beyond current

        Returns:
            List of school years starting with current, followed by future years
            Example: ["2025-2026", "2026-2027", "2027-2028", "2028-2029"]
        """
        try:
            # Parse the start year from "2025-2026" format
            start_year = int(current_year.split("-")[0])
        except (ValueError, IndexError):
            raise ValueError(f"Invalid school year format: {current_year}. Expected 'YYYY-YYYY'")

        # Generate list: current + num_future years
        years = [current_year]

        for i in range(1, num_future + 1):
            next_start = start_year + i
            next_end = next_start + 1
            years.append(f"{next_start}-{next_end}")

        return years

    def _fetch_secret(self, secret_id: str) -> Optional[str]:
        """Fetch a secret value from the external API.

        Args:
            secret_id: The ID of the secret to fetch

        Returns:
            The secret value or None if fetch fails
        """
        url = f"{self.API_BASE_URL}/{secret_id}"
        headers = {"X-API-Key": self._api_key}

        try:
            response = requests.get(url, headers=headers, timeout=10)
            
            response.raise_for_status()
            data = response.json()
            return data.get("value")
        except requests.exceptions.RequestException as e:
            print(f"Error fetching secret {secret_id} from API: {e}")
            return None
        except Exception as e:
            print(f"Unexpected error fetching secret {secret_id}: {e}")
            return None

    def _get_cached_years(self) -> Optional[List[str]]:
        """Get cached school years if still valid.

        Returns:
            List of cached school years if cache is fresh, None otherwise
        """
        try:
            doc = self._firestore.db.collection(self.CACHE_COLLECTION).document(self.CACHE_DOCUMENT).get()
            
            if not doc.exists:
                return None

            data = doc.to_dict()
            cached_at = data.get("cached_at")
            ttl_hours = self._school_year_config.get("cache_ttl_hours", 24)

            if cached_at and isinstance(cached_at, datetime):
                cache_age = datetime.now() - cached_at
                if cache_age < timedelta(hours=ttl_hours):
                    # Cache is still fresh, return active years
                    return data.get("active_years", [])

            return None
        except Exception as e:
            print(f"Error reading cached school years: {e}")
            return None

    def _cache_years(
        self,
        active_years: List[str],
        current_year: str
    ) -> None:
        """Cache school years in Firestore.

        Args:
            active_years: List of currently active school years (current + 3 future)
            current_year: The current school year from external API
        """
        try:
            cache_data = {
                "active_years": active_years,
                "current_year": current_year,
                "future_years": active_years[1:],  # All years except current
                "cached_at": datetime.now(),
                "num_future_years": len(active_years) - 1
            }

            self._firestore.db.collection(self.CACHE_COLLECTION).document(self.CACHE_DOCUMENT).set(cache_data)
        except Exception as e:
            print(f"Warning: Failed to cache school years: {e}")

    def get_field_config_for_entity(self, entity: str) -> Optional[Dict[str, Any]]:
        """Get the school year field configuration for a specific entity.

        Args:
            entity: Entity name (students, parents, contractors, etc.)

        Returns:
            Dict with 'field_name' and 'filter_type' keys, or None if no filtering for entity
        """
        field_mappings = self._school_year_config.get("field_mappings", {})
        field_config = field_mappings.get(entity)

        if not field_config:
            return None

        return field_config

    def refresh_cache(self) -> Dict[str, Any]:
        """Force refresh of school year cache from API.

        Returns:
            Dict with active_years, current_year, and future_years
        """
        current_year = self._fetch_secret(self.CURRENT_YEAR_SECRET_ID)

        if not current_year:
            raise ValueError("Failed to fetch current school year from external API")

        active_years = self._generate_future_years(current_year, self.NUM_FUTURE_YEARS)
        self._cache_years(active_years, current_year)

        return {
            "active_years": active_years,
            "current_year": current_year,
            "future_years": active_years[1:],
            "num_future_years": len(active_years) - 1
        }
