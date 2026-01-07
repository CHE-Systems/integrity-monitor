"""Value check validation driven by schema config.

Flags records when specified fields contain values (opposite of required_fields).
Supports cross-entity rules using source_entity to check records from one entity
while displaying rules under another entity.

IMPORTANT: See docs/rules.md for field reference formats (IDs vs names) and
schema snapshot requirements. Rules can use either field IDs (fld...) or
field names; the system resolves both via backend/utils/records.py:get_field().
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Tuple
from collections import defaultdict

from ..config.models import ValueCheck, SchemaConfig
from ..utils.issues import IssuePayload
from ..utils.records import get_field, matches_condition

logger = logging.getLogger(__name__)


def run(records: Dict[str, list], schema_config: SchemaConfig) -> List[IssuePayload]:
    issues: List[IssuePayload] = []
    
    # Group value checks by source_entity (or entity if not specified)
    # This allows rules stored under one entity to check records from another
    checks_by_source: Dict[str, List[Tuple[str, ValueCheck]]] = defaultdict(list)
    
    for entity_name, entity_schema in schema_config.entities.items():
        value_checks = entity_schema.value_checks
        if not value_checks:
            continue
        
        for check in value_checks:
            # Use source_entity if specified, otherwise use the rule's entity
            source_entity = check.source_entity or entity_name
            checks_by_source[source_entity].append((entity_name, check))
    
    # Count rules per source entity
    source_rule_counts = {
        source: len(checks)
        for source, checks in checks_by_source.items()
    }
    
    if source_rule_counts:
        logger.info(
            "Value checks: processing source entities",
            extra={
                "category": "value_checks",
                "source_entity_rule_counts": source_rule_counts,
                "total_source_entities": len(source_rule_counts),
                "total_rules": sum(source_rule_counts.values()),
            }
        )
    
    # Process each source entity
    for source_entity, check_list in checks_by_source.items():
        source_records = records.get(source_entity, [])

        if not source_records:
            # Build rule IDs for logging
            rule_ids = []
            rule_entities = []
            for rule_entity, check in check_list:
                rule_id = check.rule_id or f"value_check.{rule_entity}.{check.field}"
                rule_ids.append(rule_id)
                rule_entities.append(rule_entity)

            logger.warning(
                f"Value checks: No {source_entity} records fetched - {len(check_list)} rule(s) could not be applied",
                extra={
                    "category": "value_checks",
                    "source_entity": source_entity,
                    "rule_count": len(check_list),
                    "rule_ids": rule_ids,
                    "rule_entities": list(set(rule_entities)),
                    "hint": f"To apply these rules, include '{source_entity}' entity in your scan configuration"
                }
            )
            continue
        
        # Build rule IDs and field names for logging
        rule_ids = []
        field_names = []
        for rule_entity, check in check_list:
            rule_id = check.rule_id or f"value_check.{rule_entity}.{check.field}"
            rule_ids.append(rule_id)
            field_names.append(check.field)
        
        logger.info(
            f"Value checks: processing {source_entity}",
            extra={
                "category": "value_checks",
                "source_entity": source_entity,
                "rule_count": len(check_list),
                "rule_ids": rule_ids,
                "fields": field_names,
                "record_count": len(source_records),
            }
        )
        
        # Initialize issues_by_rule for ALL rules (set to 0)
        issues_by_rule = {check_list[i][1].rule_id or f"value_check.{check_list[i][0]}.{check_list[i][1].field}": 0 
                         for i in range(len(check_list))}
        
        # Track issues by rule_id + record_id to prevent duplicates
        seen_issues = set()
        duplicates_prevented = 0
        
        for record in source_records:
            fields = record.get("fields", {})
            record_id = record.get("id")
            
            for rule_entity, check in check_list:
                # Check condition if specified
                if not matches_condition(fields, check.condition_field, check.condition_value):
                    continue
                
                # Check if field has a value (flag if it does)
                if _has_value(fields, check):
                    rule_id = check.rule_id or f"value_check.{rule_entity}.{check.field}"
                    issue_key = f"{rule_id}:{record_id}"
                    
                    # Prevent duplicate issues from same rule+record
                    if issue_key in seen_issues:
                        duplicates_prevented += 1
                        logger.warning(
                            f"Skipping duplicate issue: {issue_key}",
                            extra={
                                "rule_id": rule_id,
                                "record_id": record_id,
                                "source_entity": source_entity,
                                "rule_entity": rule_entity,
                            }
                        )
                        continue
                    
                    seen_issues.add(issue_key)
                    issues.append(
                        IssuePayload(
                            rule_id=rule_id,
                            issue_type="value_present",
                            entity=rule_entity,  # Use rule_entity for display (where rule is stored)
                            record_id=record_id,
                            severity=check.severity,
                            description=check.message or f"Field {check.field} has a value",
                        )
                    )
                    issues_by_rule[rule_id] += 1
        
        if duplicates_prevented > 0:
            logger.warning(
                f"Prevented {duplicates_prevented} duplicate issues for {source_entity}",
                extra={
                    "source_entity": source_entity,
                    "duplicates_prevented": duplicates_prevented,
                }
            )
        
        # Always log summary, even if all rules found 0 issues
        logger.info(
            f"Value checks: completed for {source_entity}",
            extra={
                "category": "value_checks",
                "source_entity": source_entity,
                "total_issues": sum(issues_by_rule.values()),
                "rule_issues": dict(issues_by_rule),  # Shows all rules with their issue counts (including 0)
            }
        )
    
    logger.info(
        "Value checks: completed",
        extra={
            "category": "value_checks",
            "total_issues": len(issues),
        }
    )
    
    return issues


def _has_value(fields: Dict[str, Any], check: ValueCheck) -> bool:
    """Check if a record has a value in the specified field.
    
    Returns True if the field has a value (should be flagged), False otherwise.
    This is the opposite of required_fields - we flag when a value IS present.
    """
    # Use the field reference (should be field ID if available, otherwise field name)
    field_ref = check.field
    
    # Try to get the field value
    field_value = get_field(fields, field_ref)
    
    # Enhanced logging for debugging field resolution issues
    is_field_id = field_ref.startswith("fld") and len(field_ref) >= 14
    logger.debug(
        f"Checking value check field",
        extra={
            "field_reference": field_ref,
            "field_type": "field_id" if is_field_id else "field_name",
            "value_retrieved": field_value,
            "value_type": type(field_value).__name__ if field_value is not None else "None",
            "has_value": _is_valid_value(field_value),
            "available_field_keys": list(fields.keys())[:10],  # First 10 keys for debugging
            "field_keys_sample": [k[:20] + "..." if len(k) > 20 else k for k in list(fields.keys())[:10]],
        }
    )
    
    # If field not found and we're using a field ID, log a warning
    if field_value is None and is_field_id:
        logger.warning(
            f"Field ID {field_ref} not found in record. This may indicate a schema mismatch.",
            extra={
                "field_id": field_ref,
                "available_keys_count": len(fields),
                "rule_id": check.rule_id,
            }
        )
    
    # Return True if field has a valid value (should be flagged)
    return _is_valid_value(field_value)


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

