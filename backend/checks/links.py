"""Link consistency checks driven by schema config (prompt 4)."""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional, Tuple
from collections import defaultdict

from ..config.models import SchemaConfig, RelationshipRule
from ..utils.issues import IssuePayload
from ..utils.records import (
    build_record_index,
    get_list_field,
    get_field,
    matches_condition,
    is_record_active,
)

logger = logging.getLogger(__name__)


def run(records: Dict[str, list], schema_config: SchemaConfig) -> List[IssuePayload]:
    """Run link consistency checks with active status and orphan validation."""
    issues: List[IssuePayload] = []
    record_index = build_record_index(records)
    
    # Track seen issue keys to prevent duplicates within this check
    seen_issues: set[str] = set()
    
    # Count relationship rules per entity
    entity_rel_counts = {
        entity: len(entity_schema.relationships)
        for entity, entity_schema in schema_config.entities.items()
        if entity_schema.relationships
    }
    
    if entity_rel_counts:
        logger.info(
            "Links check: processing entities",
            extra={
                "category": "links",
                "entity_rel_counts": entity_rel_counts,
                "total_entities": len(entity_rel_counts),
                "total_rules": sum(entity_rel_counts.values()),
            }
        )
    
    for entity_name, entity_schema in schema_config.entities.items():
        entity_records = records.get(entity_name, [])
        if not entity_schema.relationships:
            continue
        
        rel_keys = list(entity_schema.relationships.keys())
        logger.info(
            f"Links check: processing {entity_name}",
            extra={
                "category": "links",
                "entity": entity_name,
                "relationship_count": len(entity_schema.relationships),
                "relationship_keys": rel_keys,
                "record_count": len(entity_records),
            }
        )
        
        # Initialize issues_by_relationship for ALL relationships (set to 0)
        issues_by_relationship = {rel_key: 0 for rel_key in rel_keys}
        for record in entity_records:
            record_id = record.get("id")
            fields = record.get("fields", {})
            for rel_key, rel_rule in entity_schema.relationships.items():
                if not matches_condition(fields, rel_rule.condition_field, rel_rule.condition_value):
                    continue
                
                # Resolve links and get actual record objects
                link_records = _resolve_and_validate_links(
                    fields, rel_key, rel_rule.target, record_index
                )
                
                # Detect orphaned links
                orphaned_ids = _detect_orphans(link_records)
                if orphaned_ids:
                    rule_id = f"link.{entity_name}.{rel_key}.orphan"
                    issue_key = f"{rule_id}:{record_id}"
                    if issue_key not in seen_issues:
                        seen_issues.add(issue_key)
                        issues.append(
                            IssuePayload(
                                rule_id=rule_id,
                                issue_type="orphaned_link",
                                entity=entity_name,
                                record_id=record_id,
                                severity="critical",
                                description=f"Link to {rel_rule.target} record {orphaned_ids[0]} does not exist (orphaned).",
                                metadata={
                                    "target_entity": rel_rule.target,
                                    "orphaned_ids": orphaned_ids,
                                    "relationship": rel_key,
                                },
                            )
                        )
                        issues_by_relationship[f"{rel_key}.orphan"] += 1
                
                # Filter out orphans for further validation
                valid_links = [(lid, rec) for lid, rec in link_records if rec is not None]
                
                # Validate active status if required
                active_ids, inactive_ids = _validate_active_links(
                    valid_links, rel_rule.require_active
                )
                
                # Count active links (or all links if require_active is False)
                if rel_rule.require_active:
                    count = len(active_ids)
                    valid_count = len(valid_links)
                else:
                    count = len(valid_links)
                    valid_count = count
                    active_ids = [lid for lid, _ in valid_links]
                    inactive_ids = []
                
                # Check min_links requirement
                if rel_rule.min_links and count < rel_rule.min_links:
                    rule_id = f"link.{entity_name}.{rel_key}.min"
                    issue_key = f"{rule_id}:{record_id}"
                    if issue_key not in seen_issues:
                        seen_issues.add(issue_key)
                        metadata = {
                            "actual": count,
                            "expected_min": rel_rule.min_links,
                            "valid_count": valid_count,
                            "active_count": len(active_ids),
                            "inactive_count": len(inactive_ids),
                            "orphaned_count": len(orphaned_ids),
                        }
                        if orphaned_ids:
                            metadata["orphaned_ids"] = orphaned_ids[:10]  # Limit to first 10
                        if inactive_ids:
                            metadata["inactive_ids"] = inactive_ids[:10]
                        
                        severity = "critical" if orphaned_ids else ("warning" if inactive_ids else "warning")
                        issues.append(
                            IssuePayload(
                                rule_id=rule_id,
                                issue_type="missing_link",
                                entity=entity_name,
                                record_id=record_id,
                                severity=severity,
                                description=rel_rule.message,
                                metadata=metadata,
                            )
                        )
                        issues_by_relationship[f"{rel_key}.min"] += 1
                
                # Check max_links requirement
                if rel_rule.max_links is not None and count > rel_rule.max_links:
                    rule_id = f"link.{entity_name}.{rel_key}.max"
                    issue_key = f"{rule_id}:{record_id}"
                    if issue_key not in seen_issues:
                        seen_issues.add(issue_key)
                        metadata = {
                            "actual": count,
                            "expected_max": rel_rule.max_links,
                            "valid_count": valid_count,
                            "active_count": len(active_ids),
                            "inactive_count": len(inactive_ids),
                            "orphaned_count": len(orphaned_ids),
                        }
                        if active_ids:
                            metadata["active_ids"] = active_ids[:10]
                        
                        issues.append(
                            IssuePayload(
                                rule_id=rule_id,
                                issue_type="excessive_link",
                                entity=entity_name,
                                record_id=record_id,
                                severity="info",
                                description=f"{rel_rule.message} (limit {rel_rule.max_links})",
                                metadata=metadata,
                            )
                        )
                        issues_by_relationship[f"{rel_key}.max"] += 1
                
                # Report inactive links separately if require_active is True
                if rel_rule.require_active and inactive_ids:
                    rule_id = f"link.{entity_name}.{rel_key}.inactive"
                    issue_key = f"{rule_id}:{record_id}"
                    if issue_key not in seen_issues:
                        seen_issues.add(issue_key)
                        issues.append(
                            IssuePayload(
                                rule_id=rule_id,
                                issue_type="inactive_link",
                                entity=entity_name,
                                record_id=record_id,
                                severity="warning",
                                description=f"Some linked {rel_rule.target} records are inactive.",
                                metadata={
                                    "inactive_count": len(inactive_ids),
                                    "inactive_ids": inactive_ids[:10],
                                    "target_entity": rel_rule.target,
                                },
                            )
                        )
                        issues_by_relationship[f"{rel_key}.inactive"] += 1
                
                # Validate bidirectional relationships if configured
                if rel_rule.validate_bidirectional and rel_rule.reverse_relationship_key:
                    bidirectional_issues = _validate_bidirectional(
                        entity_name,
                        record_id,
                        rel_key,
                        active_ids,
                        rel_rule.target,
                        rel_rule.reverse_relationship_key,
                        record_index,
                    )
                    issues.extend(bidirectional_issues)
                    if bidirectional_issues:
                        issues_by_relationship[f"{rel_key}.bidirectional"] += len(bidirectional_issues)
                
                # Validate cross-entity field matching if configured
                if rel_rule.cross_entity_validation and valid_links:
                    cross_entity_issues = _validate_cross_entity(
                        record,
                        valid_links,
                        rel_rule.cross_entity_validation,
                        entity_name,
                        rel_key,
                    )
                    issues.extend(cross_entity_issues)
                    if cross_entity_issues:
                        issues_by_relationship[f"{rel_key}.cross_entity"] += len(cross_entity_issues)
        
        # Always log summary, even if all relationships found 0 issues
        logger.info(
            f"Links check: completed for {entity_name}",
            extra={
                "category": "links",
                "entity": entity_name,
                "total_issues": sum(issues_by_relationship.values()),
                "relationship_issues": dict(issues_by_relationship),  # Shows all relationships with their issue counts (including 0)
            }
        )
    
    logger.info(
        "Links check: completed",
        extra={
            "category": "links",
            "total_issues": len(issues),
        }
    )
    
    return issues


def _validate_bidirectional(
    entity_name: str,
    record_id: str,
    rel_key: str,
    link_ids: List[str],
    target_entity: str,
    reverse_key: str,
    record_index: Dict[str, Dict[str, dict]],
) -> List[IssuePayload]:
    """Validate that linked records reference back to the source record.
    
    Returns list of issues for missing reverse links.
    """
    issues: List[IssuePayload] = []
    source_entity_index = record_index.get(entity_name, {})
    source_record = source_entity_index.get(record_id)
    
    if not source_record:
        return issues
    
    target_entity_index = record_index.get(target_entity, {})
    
    for link_id in link_ids:
        linked_record = target_entity_index.get(link_id)
        if not linked_record:
            continue  # Already handled as orphan
        
        linked_fields = linked_record.get("fields", {})
        reverse_links = _resolve_links(linked_fields, reverse_key)
        
        if record_id not in reverse_links:
            issues.append(
                IssuePayload(
                    rule_id=f"link.{entity_name}.{rel_key}.bidirectional",
                    issue_type="missing_reverse_link",
                    entity=entity_name,
                    record_id=record_id,
                    severity="info",
                    description=f"Linked {target_entity} record {link_id} does not reference back to this {entity_name} record.",
                    metadata={
                        "target_entity": target_entity,
                        "linked_record_id": link_id,
                        "reverse_relationship": reverse_key,
                        "expected_reverse_link": record_id,
                    },
                )
            )
    
    return issues


def _validate_cross_entity(
    source_record: dict,
    link_records: List[Tuple[str, Optional[dict]]],
    validation_rules: Dict[str, str],
    entity_name: str,
    rel_key: str,
) -> List[IssuePayload]:
    """Validate that linked records have matching field values.
    
    Args:
        source_record: The source record dict
        link_records: List of (link_id, linked_record) tuples
        validation_rules: Dict mapping source_field -> target_field
        entity_name: Name of source entity
        rel_key: Relationship key
        
    Returns:
        List of issues for mismatched fields
    """
    issues: List[IssuePayload] = []
    source_fields = source_record.get("fields", {})
    record_id = source_record.get("id")
    
    for link_id, linked_record in link_records:
        if not linked_record:
            continue  # Already handled as orphan
        
        linked_fields = linked_record.get("fields", {})
        
        for source_field, target_field in validation_rules.items():
            source_value = get_field(source_fields, source_field)
            target_value = get_field(linked_fields, target_field)
            
            if source_value is None or target_value is None:
                continue  # Skip if either field is missing
            
            # Normalize for comparison
            source_str = str(source_value).strip().lower()
            target_str = str(target_value).strip().lower()
            
            if source_str != target_str:
                issues.append(
                    IssuePayload(
                        rule_id=f"link.{entity_name}.{rel_key}.cross_entity_mismatch",
                        issue_type="cross_entity_mismatch",
                        entity=entity_name,
                        record_id=record_id,
                        severity="warning",
                        description=f"Field mismatch: {source_field} ({source_value}) does not match linked record's {target_field} ({target_value}).",
                        metadata={
                            "source_field": source_field,
                            "source_value": str(source_value),
                            "target_field": target_field,
                            "target_value": str(target_value),
                            "linked_record_id": link_id,
                        },
                    )
                )
    
    return issues


def _resolve_links(fields: Dict[str, Any], rel_key: str) -> List[str]:
    """Extract link IDs from record fields (backward compatibility)."""
    candidates = [rel_key, f"{rel_key}_id", f"{rel_key}_ids", f"{rel_key}_links", f"{rel_key}s"]
    seen = set()
    values: List[str] = []
    for candidate in candidates:
        links = get_list_field(fields, candidate)
        for value in links:
            if value not in seen:
                values.append(value)
                seen.add(value)
    return values


def _resolve_and_validate_links(
    fields: Dict[str, Any],
    rel_key: str,
    target_entity: str,
    record_index: Dict[str, Dict[str, dict]],
) -> List[Tuple[str, Optional[dict]]]:
    """Resolve link IDs and return tuples of (link_id, linked_record).
    
    Returns None for linked_record if the link is orphaned (doesn't exist).
    """
    link_ids = _resolve_links(fields, rel_key)
    target_index = record_index.get(target_entity, {})
    result: List[Tuple[str, Optional[dict]]] = []
    for link_id in link_ids:
        linked_record = target_index.get(link_id)
        result.append((link_id, linked_record))
    return result


def _detect_orphans(
    link_records: List[Tuple[str, Optional[dict]]],
) -> List[str]:
    """Detect orphaned links (pointing to non-existent records).
    
    Returns list of orphaned link IDs.
    """
    return [link_id for link_id, record in link_records if record is None]


def _validate_active_links(
    link_records: List[Tuple[str, Optional[dict]]],
    require_active: bool,
) -> Tuple[List[str], List[str]]:
    """Filter links by active status.
    
    Returns (active_link_ids, inactive_link_ids).
    Only filters when require_active is True.
    """
    if not require_active:
        # Return all non-orphaned links as active
        active = [link_id for link_id, record in link_records if record is not None]
        return active, []
    
    active_ids: List[str] = []
    inactive_ids: List[str] = []
    
    for link_id, record in link_records:
        if record is None:
            continue  # Orphans handled separately
        if is_record_active(record):
            active_ids.append(link_id)
        else:
            inactive_ids.append(link_id)
    
    return active_ids, inactive_ids
