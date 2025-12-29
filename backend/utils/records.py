"""Helpers for reading Airtable-style record dictionaries.

This module implements field resolution between Airtable field IDs (fld...) and
field names. See docs/rules.md for complete documentation on field reference
formats and the schema snapshot system that enables this resolution.
"""

from __future__ import annotations

from functools import lru_cache
import json
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


def build_record_index(records: Dict[str, list]) -> Dict[str, Dict[str, dict]]:
    """Build an index of records by entity and ID for O(1) lookups.
    
    Args:
        records: Dictionary mapping entity names to lists of record dicts
        
    Returns:
        Nested dictionary: {entity_name: {record_id: record_dict}}
    """
    index: Dict[str, Dict[str, dict]] = {}
    for entity_name, entity_records in records.items():
        entity_index: Dict[str, dict] = {}
        for record in entity_records:
            record_id = record.get("id")
            if record_id:
                entity_index[record_id] = record
        index[entity_name] = entity_index
    return index


def is_record_active(record: dict, status_fields: Optional[List[str]] = None) -> bool:
    """Check if a record is considered active based on status fields.
    
    Args:
        record: Record dictionary with 'fields' key
        status_fields: Optional list of field names to check. If None, uses common defaults.
        
    Returns:
        True if record appears active, False otherwise
    """
    if not record:
        return False
    
    fields = record.get("fields", {})
    if not fields:
        return True  # Assume active if no fields (conservative)
    
    # Default status field names to check
    default_status_fields = ["status", "is_active", "active", "enrollment_status", "record_status"]
    check_fields = status_fields or default_status_fields
    
    # Check each status field
    for field_name in check_fields:
        value = get_field(fields, field_name)
        if value is None:
            continue
        
        value_str = str(value).lower().strip()
        
        # Active indicators
        if value_str in ("active", "enrolled", "current", "true", "1", "yes"):
            return True
        
        # Inactive indicators
        if value_str in ("archived", "inactive", "deleted", "withdrawn", "false", "0", "no"):
            return False
    
    # If no status field found or ambiguous, check for common "archived" patterns
    archived_indicators = ["archived", "is_archived", "deleted", "is_deleted"]
    for indicator in archived_indicators:
        if get_field(fields, indicator):
            value = get_field(fields, indicator)
            if isinstance(value, bool) and value:
                return False
            if str(value).lower() in ("true", "1", "yes"):
                return False
    
    # Default to active if no clear inactive signal
    return True


def _normalize_name(value: str) -> str:
    """Normalize field name for matching: case-insensitive, underscores->spaces, remove punctuation, collapse whitespace.

    This normalization allows flexible field name matching:
    - "Driver's License" matches "Drivers License"
    - "Email_Address" matches "Email Address"
    - "Cell phone" matches "cell_phone"
    """
    import re
    # Remove apostrophes and other punctuation (except underscores which are replaced below)
    value = re.sub(r"['\"`!@#$%^&*()+=\[\]{}|\\:;<>,.?/~-]", "", value)
    # Replace underscores with spaces
    value = value.replace("_", " ")
    # Lowercase, strip, and collapse whitespace
    return " ".join(value.strip().lower().split())


@lru_cache(maxsize=1)
def _load_airtable_field_maps() -> Tuple[Dict[str, str], Dict[str, List[str]]]:
    """Load fieldId<->fieldName mappings from backend/config/airtable_schema.json.

    This allows rules stored with Airtable field IDs (fld...) to work even when
    fetched records are keyed by field *names*, and vice-versa.

    Cached at module level for performance - this function is called thousands of times
    during integrity checks but the schema rarely changes.
    """
    schema_path = Path(__file__).resolve().parent.parent / "config" / "airtable_schema.json"
    try:
        with schema_path.open("r", encoding="utf-8") as handle:
            schema = json.load(handle)
    except FileNotFoundError:
        return {}, {}
    except Exception:
        # Don't fail scans if schema snapshot can't be read; fall back to legacy behavior.
        return {}, {}

    id_to_name: Dict[str, str] = {}
    name_to_ids: Dict[str, List[str]] = {}

    for table in schema.get("tables", []) or []:
        for field in table.get("fields", []) or []:
            field_id = field.get("id")
            field_name = field.get("name")
            if not isinstance(field_id, str) or not isinstance(field_name, str):
                continue
            id_to_name[field_id] = field_name

            norm = _normalize_name(field_name)
            name_to_ids.setdefault(norm, []).append(field_id)

    return id_to_name, name_to_ids


def get_field(fields: Dict[str, Any], key: str) -> Any:
    """Attempt to retrieve a field by key or friendly variants.

    Supports both field names and Airtable field IDs (starting with "fld").
    Field IDs are looked up directly, while field names use variant matching.

    Args:
        fields: Dictionary of field values from Airtable record
        key: Field name or Airtable field ID (e.g., "flddCJDACjAsP1ltS")

    Returns:
        Field value or None if not found
    """
    import logging
    logger = logging.getLogger(__name__)
    
    if not key:
        return None

    # If key is an Airtable field ID (starts with "fld"), look it up directly
    if key.startswith("fld") and len(key) >= 14:
        if key in fields:
            return fields[key]
        # Records are often keyed by field *names*; resolve field ID -> name using schema snapshot
        id_to_name, _name_to_ids = _load_airtable_field_maps()
        field_name = id_to_name.get(key)
        if field_name and field_name in fields:
            return fields[field_name]
        # Log when field ID cannot be resolved
        logger.debug(
            f"Field ID {key} not found in record fields",
            extra={
                "field_id": key,
                "resolved_name": field_name,
                "available_keys_sample": list(fields.keys())[:10],
            }
        )
        return None
    
    # Otherwise, try field name variants (backward compatibility)
    candidates = {key, key.replace("_", " "), key.title(), key.replace("_", " ").title()}
    for candidate in candidates:
        if candidate in fields:
            return fields[candidate]

    # As a fallback, resolve name -> field IDs via schema snapshot, then look up by ID or resolved name.
    id_to_name, name_to_ids = _load_airtable_field_maps()
    normalized = _normalize_name(key)
    for field_id in name_to_ids.get(normalized, []):
        if field_id in fields:
            return fields[field_id]
        field_name = id_to_name.get(field_id)
        if field_name and field_name in fields:
            return fields[field_name]
    
    # Log when field name cannot be resolved
    logger.debug(
        f"Field name '{key}' not found in record fields",
        extra={
            "field_name": key,
            "normalized": normalized,
            "matched_field_ids": name_to_ids.get(normalized, []),
            "available_keys_sample": list(fields.keys())[:10],
        }
    )
    return None


def get_list_field(fields: Dict[str, Any], key: str) -> List[str]:
    value = get_field(fields, key)
    if isinstance(value, list):
        return [str(v) for v in value if v]
    if isinstance(value, str) and value:
        return [value]
    return []


def matches_condition(fields: Dict[str, Any], condition_field: Optional[str], condition_value: Optional[str]) -> bool:
    if not condition_field:
        return True
    current = get_field(fields, condition_field)
    if condition_value is None:
        return bool(current)
    return str(current).lower() == str(condition_value).lower()
