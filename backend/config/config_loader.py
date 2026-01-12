"""Load runtime configuration for the integrity monitor."""

from __future__ import annotations

import hashlib
import logging
import os
import re
from pathlib import Path
from typing import Any, Dict, Optional

import yaml

from .settings import RuntimeConfig

logger = logging.getLogger(__name__)

CONFIG_PATH = Path(__file__).with_name("rules.yaml")

# Pattern to match env("VAR_NAME") placeholders
ENV_PATTERN = re.compile(r'env\("([^"]+)"\)')

# Cache for discovered table IDs to avoid repeated discovery
_discovered_ids_cache: Optional[Dict[str, str]] = None


def _attempt_table_id_discovery(var_name: str) -> Optional[str]:
    """Attempt to discover table ID or base ID for a missing environment variable.
    
    Args:
        var_name: Environment variable name (e.g., "AT_STUDENTS_TABLE" or "AT_STUDENTS_BASE")
        
    Returns:
        Discovered ID if found, None otherwise
    """
    global _discovered_ids_cache
    
    # Only attempt discovery for Airtable variables (AT_*_TABLE or AT_*_BASE)
    if not var_name.startswith("AT_") or not (var_name.endswith("_TABLE") or var_name.endswith("_BASE")):
        return None
    
    is_base = var_name.endswith("_BASE")
    
    try:
        # Use cached discovered IDs if available
        if _discovered_ids_cache is None:
            from ..services.table_id_discovery import discover_table_ids
            discovery_result = discover_table_ids()
            # Cache the full result
            _discovered_ids_cache = discovery_result
        
        # Handle base ID discovery
        if is_base:
            return _discovered_ids_cache.get("base_id")
        
        # Handle table ID discovery
        # Extract entity name from var name (e.g., "AT_STUDENTS_TABLE" -> "students")
        entity = var_name[3:-6].lower()  # Remove "AT_" prefix and "_TABLE" suffix
        table_ids = _discovered_ids_cache.get("table_ids", {})
        return table_ids.get(entity)
    except Exception as exc:
        logger.debug(f"Failed to discover ID for {var_name}: {exc}")
        return None


def _resolve_env_placeholders(value: Any, attempt_discovery: bool = True) -> Any:
    """Recursively resolve env("VAR") placeholders in YAML values.
    
    Args:
        value: Value to resolve (can be str, dict, list, or other)
        attempt_discovery: If True, attempt auto-discovery for missing table ID env vars
    """
    if isinstance(value, str):
        match = ENV_PATTERN.search(value)
        if match:
            var_name = match.group(1)
            env_value = os.getenv(var_name)
            
            if env_value is None:
                # Attempt auto-discovery for table ID variables
                if attempt_discovery:
                    discovered_value = _attempt_table_id_discovery(var_name)
                    if discovered_value:
                        logger.info(
                            f"Auto-discovered {var_name}={discovered_value} from schema",
                        )
                        # Set it in environment for this process
                        os.environ[var_name] = discovered_value
                        return discovered_value
                
                # Log warning but don't fail - let the caller decide
                logger.warning(
                    f"Environment variable {var_name} not set and could not be auto-discovered. "
                    "Some features may not work correctly."
                )
                raise ValueError(f"Environment variable {var_name} not set (required by config)")
            
            return env_value
        return value
    elif isinstance(value, dict):
        return {k: _resolve_env_placeholders(v, attempt_discovery) for k, v in value.items()}
    elif isinstance(value, list):
        return [_resolve_env_placeholders(item, attempt_discovery) for item in value]
    else:
        return value


def _deep_merge(base: Dict[str, Any], override: Dict[str, Any]) -> Dict[str, Any]:
    """Deep merge override dict into base dict.
    
    Filters out table_id from airtable overrides since RuntimeConfig expects
    base_env and table_env, not table_id. The table_id is metadata only.
    """
    result = base.copy()
    for key, value in override.items():
        if key in result and isinstance(result[key], dict) and isinstance(value, dict):
            # Special handling for airtable config: filter out table_id
            if key == "airtable":
                filtered_value = {}
                for entity, entity_config in value.items():
                    if isinstance(entity_config, dict):
                        # Copy entity config but exclude table_id
                        filtered_entity_config = {
                            k: v for k, v in entity_config.items() if k != "table_id"
                        }
                        if filtered_entity_config:  # Only include if there are other fields
                            filtered_value[entity] = filtered_entity_config
                    else:
                        filtered_value[entity] = entity_config
                if filtered_value:
                    result[key] = _deep_merge(result[key], filtered_value)
            else:
                result[key] = _deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def _load_firestore_overrides(firestore_client: Optional[Any] = None) -> Dict[str, Any]:
    """Load configuration overrides from Firestore.
    
    Args:
        firestore_client: Optional FirestoreClient instance. If None, returns empty dict.
    
    Returns:
        Dict of override values, or empty dict if Firestore not available.
    """
    if firestore_client is None:
        return {}
    
    try:
        client = firestore_client._get_client()
        
        config_doc_path = firestore_client._config.config_document
        # Parse document path (e.g., "integrity_config/current")
        parts = config_doc_path.split("/")
        if len(parts) != 2:
            return {}
        
        collection_name, doc_id = parts
        doc_ref = client.collection(collection_name).document(doc_id)
        
        doc = doc_ref.get()
        
        if doc.exists:
            return doc.to_dict() or {}
    except Exception:
        # If Firestore is not available or document doesn't exist, return empty dict
        return {}
    
    return {}


def _compute_config_version(yaml_content: str, override_content: Dict[str, Any]) -> str:
    """Compute SHA256 hash of YAML content + override content for version tracking."""
    import json
    
    combined = {
        "yaml": yaml_content,
        "override": json.dumps(override_content, sort_keys=True),
    }
    combined_str = json.dumps(combined, sort_keys=True)
    return hashlib.sha256(combined_str.encode("utf-8")).hexdigest()[:16]


def load_runtime_config(
    path: Optional[Path] = None,
    firestore_client: Optional[Any] = None,
    attempt_discovery: bool = False,
) -> RuntimeConfig:
    """Load runtime configuration from YAML file with optional Firestore overrides.
    
    Args:
        path: Optional path to rules.yaml file. Defaults to CONFIG_PATH.
        firestore_client: Optional FirestoreClient for loading overrides.
        attempt_discovery: If True, attempt auto-discovery for missing table ID env vars.
                          Defaults to False to avoid blocking during server startup.
    
    Returns:
        RuntimeConfig instance with resolved env placeholders and merged overrides.
    """
    target = path or CONFIG_PATH
    
    # Read YAML file
    with target.open("r", encoding="utf-8") as handle:
        yaml_content = handle.read()
        data = yaml.safe_load(yaml_content)
    
    # Resolve env() placeholders (disable auto-discovery during startup by default)
    data = _resolve_env_placeholders(data, attempt_discovery=attempt_discovery)
    
    # Load Firestore overrides
    overrides = _load_firestore_overrides(firestore_client)
    
    # Deep merge overrides into base config
    if overrides:
        data = _deep_merge(data, overrides)
    
    # Compute config version
    config_version = _compute_config_version(yaml_content, overrides)
    
    # Add config_version to metadata
    if "metadata" not in data:
        data["metadata"] = {}
    data["metadata"]["config_version"] = config_version
    
    return RuntimeConfig.model_validate(data)
