"""Required field validation driven by schema config.

IMPORTANT: See docs/rules.md for field reference formats (IDs vs names) and
schema snapshot requirements. Rules can use either field IDs (fld...) or
field names; the system resolves both via backend/utils/records.py:get_field().
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List
from collections import defaultdict

from ..config.models import FieldRequirement, SchemaConfig
from ..utils.issues import IssuePayload
from ..utils.records import get_field, matches_condition

logger = logging.getLogger(__name__)


def run(records: Dict[str, list], schema_config: SchemaConfig) -> List[IssuePayload]:
    issues: List[IssuePayload] = []

    # Track field IDs that have already been warned about to avoid spam
    warned_field_ids = set()

    # Count rules per entity
    entity_rule_counts = {
        entity: len(entity_schema.missing_key_data)
        for entity, entity_schema in schema_config.entities.items()
        if entity_schema.missing_key_data
    }

    if entity_rule_counts:
        logger.info(
            "Required fields check: processing entities",
            extra={
                "category": "required_fields",
                "entity_rule_counts": entity_rule_counts,
                "total_entities": len(entity_rule_counts),
                "total_rules": sum(entity_rule_counts.values()),
            }
        )
    
    for entity_name, entity_schema in schema_config.entities.items():
        requirements = entity_schema.missing_key_data
        if not requirements:
            continue

        entity_records = records.get(entity_name, [])
        rule_ids = [req.rule_id or f"required.{entity_name}.{req.field}" for req in requirements]
        field_names = [req.field for req in requirements]

        # CRITICAL DEBUG: Show EXACTLY what rules are being checked
        print("=" * 80)
        print(f"REQUIRED FIELDS CHECK - EXECUTING FOR: {entity_name}")
        print("=" * 80)
        print(f"Number of requirements to check: {len(requirements)}")
        print(f"Rule IDs that will be checked:")
        for rule_id in rule_ids:
            print(f"  - {rule_id}")
        print(f"Field IDs that will be checked:")
        for field_id in field_names:
            print(f"  - {field_id}")
        print("=" * 80)

        logger.info(
            f"Required fields check: processing {entity_name}",
            extra={
                "category": "required_fields",
                "entity": entity_name,
                "rule_count": len(requirements),
                "rule_ids": rule_ids,
                "fields": field_names,
                "record_count": len(entity_records),
            }
        )
        
        # Initialize issues_by_rule for ALL rules (set to 0)
        issues_by_rule = {rule_id: 0 for rule_id in rule_ids}
        
        # Track issues by rule_id + record_id to prevent duplicates
        seen_issues = set()
        duplicates_prevented = 0
        
        for record in entity_records:
            fields = record.get("fields", {})
            record_id = record.get("id")
            for req in requirements:
                if not matches_condition(fields, req.condition_field, req.condition_value):
                    continue
                if _violates(fields, req, warned_field_ids):
                    rule_id = req.rule_id or f"required.{entity_name}.{req.field}"
                    issue_key = f"{rule_id}:{record_id}"
                    
                    # Prevent duplicate issues from same rule+record
                    if issue_key in seen_issues:
                        duplicates_prevented += 1
                        logger.warning(
                            f"Skipping duplicate issue: {issue_key}",
                            extra={
                                "rule_id": rule_id,
                                "record_id": record_id,
                                "entity": entity_name,
                            }
                        )
                        continue
                    
                    seen_issues.add(issue_key)
                    issues.append(
                        IssuePayload(
                            rule_id=rule_id,
                            issue_type="missing_field",
                            entity=entity_name,
                            record_id=record_id,
                            severity=req.severity,
                            description=req.message,
                        )
                    )
                    issues_by_rule[rule_id] += 1
        
        if duplicates_prevented > 0:
            logger.warning(
                f"Prevented {duplicates_prevented} duplicate issues for {entity_name}",
                extra={
                    "entity": entity_name,
                    "duplicates_prevented": duplicates_prevented,
                }
            )
        
        # Always log summary, even if all rules found 0 issues
        logger.info(
            f"Required fields check: completed for {entity_name}",
            extra={
                "category": "required_fields",
                "entity": entity_name,
                "total_issues": sum(issues_by_rule.values()),
                "rule_issues": dict(issues_by_rule),  # Shows all rules with their issue counts (including 0)
            }
        )
    
    logger.info(
        "Required fields check: completed",
        extra={
            "category": "required_fields",
            "total_issues": len(issues),
        }
    )
    
    return issues


def _violates(fields: Dict[str, Any], req: FieldRequirement, warned_field_ids: set) -> bool:
    """Check if a record violates a required field requirement.

    Returns True if the field is missing/invalid, False otherwise.
    """
    # Use the field reference (should be field ID if available, otherwise field name)
    field_ref = req.field

    # Try to get the field value
    primary_value = get_field(fields, field_ref)

    # Enhanced logging for debugging field resolution issues
    is_field_id = field_ref.startswith("fld") and len(field_ref) >= 14
    logger.debug(
        f"Checking required field violation",
        extra={
            "field_reference": field_ref,
            "field_type": "field_id" if is_field_id else "field_name",
            "value_retrieved": primary_value,
            "value_type": type(primary_value).__name__ if primary_value is not None else "None",
            "is_valid": _is_valid_value(primary_value),
            "available_field_keys": list(fields.keys())[:10],  # First 10 keys for debugging
            "field_keys_sample": [k[:20] + "..." if len(k) > 20 else k for k in list(fields.keys())[:10]],
        }
    )

    # If field not found and we're using a field ID, log a warning (only once per field ID)
    if primary_value is None and is_field_id and field_ref not in warned_field_ids:
        warned_field_ids.add(field_ref)
        logger.warning(
            f"Field ID {field_ref} not found in record. This may indicate a schema mismatch. (Further warnings for this field will be suppressed)",
            extra={
                "field_id": field_ref,
                "available_keys_count": len(fields),
                "rule_id": req.rule_id,
            }
        )
    
    if _is_valid_value(primary_value):
        return False
    if req.alternate_fields:
        for alt in req.alternate_fields:
            alt_value = get_field(fields, alt)
            if _is_valid_value(alt_value):
                return False
    return True


def _is_valid_value(value: Any) -> bool:
    """Check if a value is considered valid (not missing/empty).
    
    Handles various Airtable field types:
    - String fields (including single select): non-empty after stripping whitespace
    - Numeric fields: any number including 0
    - Boolean fields: any boolean value including False
    - List fields: non-empty lists
    - Other types: any truthy value
    
    Note: Single-select fields in Airtable return the selected option as a string,
    or None if no option is selected. Empty strings should be treated as invalid.
    """
    if value is None:
        return False
    
    # For strings (including single select fields), check if non-empty after stripping
    if isinstance(value, str):
        # Empty string or whitespace-only string is invalid
        # This handles single-select fields that might return "" when unset
        return bool(value.strip())
    
    # For numbers, 0 is valid
    if isinstance(value, (int, float)):
        return True
    
    # For booleans, False is valid
    if isinstance(value, bool):
        return True
    
    # For lists (multi-select, linked records), check if non-empty
    if isinstance(value, list):
        return len(value) > 0
    
    # For other types, use default truthy check
    return bool(value)
