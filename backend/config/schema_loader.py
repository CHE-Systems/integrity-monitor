"""Utility helpers for loading the schema configuration."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Dict, List, Optional

import yaml

from .models import (
    DuplicateCondition,
    DuplicateDefinition,
    DuplicateRule,
    EntitySchema,
    FieldRequirement,
    RelationshipRule,
    SchemaConfig,
    SchemaMetadata,
    ValueCheck,
)

logger = logging.getLogger(__name__)

SCHEMA_PATH = Path(__file__).with_name("schema.yaml")


def load_schema_from_yaml(path: Optional[Path] = None) -> SchemaConfig:
    """Load schema configuration directly from YAML file.
    
    Used by migration scripts to read YAML rules before syncing to Firestore.
    
    Args:
        path: Path to schema.yaml file. If None, uses default SCHEMA_PATH.
        
    Returns:
        SchemaConfig instance built from YAML file.
    """
    yaml_path = path or SCHEMA_PATH
    
    if not yaml_path.exists():
        logger.error(f"Schema file not found: {yaml_path}")
        return SchemaConfig(
            metadata=SchemaMetadata(source="empty", generated="runtime"),
            entities={},
            duplicates={},
        )
    
    try:
        with open(yaml_path, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f)
        
        # Parse metadata
        metadata = SchemaMetadata(
            source=data.get("metadata", {}).get("source", "yaml"),
            generated=data.get("metadata", {}).get("generated", "unknown"),
        )
        
        # Parse entities
        entities: Dict[str, EntitySchema] = {}
        for entity_name, entity_data in data.get("entities", {}).items():
            # Parse relationships
            relationships: Dict[str, RelationshipRule] = {}
            for rel_key, rel_data in entity_data.get("relationships", {}).items():
                relationships[rel_key] = RelationshipRule(
                    target=rel_data.get("target", ""),
                    message=rel_data.get("message", ""),
                    min_links=rel_data.get("min_links", 0),
                    max_links=rel_data.get("max_links"),
                    require_active=rel_data.get("require_active", False),
                    allow_secondary=rel_data.get("allow_secondary", False),
                    condition_field=rel_data.get("condition_field"),
                    condition_value=rel_data.get("condition_value"),
                    notes=rel_data.get("notes"),
                    validate_bidirectional=rel_data.get("validate_bidirectional", False),
                    reverse_relationship_key=rel_data.get("reverse_relationship_key"),
                    cross_entity_validation=rel_data.get("cross_entity_validation"),
                )
            
            # Parse required fields
            missing_key_data: List[FieldRequirement] = []
            for req_data in entity_data.get("missing_key_data", []):
                missing_key_data.append(FieldRequirement(
                    field=req_data.get("field", ""),
                    rule_id=req_data.get("rule_id"),  # Load rule_id from YAML
                    message=req_data.get("message", ""),
                    severity=req_data.get("severity", "warning"),
                    alternate_fields=req_data.get("alternate_fields"),
                    condition_field=req_data.get("condition_field"),
                    condition_value=req_data.get("condition_value"),
                ))
            
            entities[entity_name] = EntitySchema(
                description=entity_data.get("description", ""),
                key_identifiers=entity_data.get("key_identifiers", []),
                identity_fields=entity_data.get("identity_fields", []),
                relationships=relationships,
                missing_key_data=missing_key_data,
            )
        
        # Parse duplicates
        duplicates: Dict[str, DuplicateDefinition] = {}
        for entity, dup_data in data.get("duplicates", {}).items():
            likely_rules: List[DuplicateRule] = []
            possible_rules: List[DuplicateRule] = []
            
            # Process likely duplicates
            for rule_data in dup_data.get("likely", []):
                conditions = []
                for cond_data in rule_data.get("conditions", []):
                    conditions.append(DuplicateCondition(
                        type=cond_data.get("type", "exact"),
                        field=cond_data.get("field"),
                        fields=cond_data.get("fields"),
                        tolerance_days=cond_data.get("tolerance_days"),
                        similarity=cond_data.get("similarity"),
                        overlap_ratio=cond_data.get("overlap_ratio"),
                        description=cond_data.get("description"),
                    ))
                likely_rules.append(DuplicateRule(
                    rule_id=rule_data.get("rule_id", ""),
                    description=rule_data.get("description", ""),
                    conditions=conditions,
                    severity=rule_data.get("severity", "warning"),
                ))
            
            # Process possible duplicates
            for rule_data in dup_data.get("possible", []):
                conditions = []
                for cond_data in rule_data.get("conditions", []):
                    conditions.append(DuplicateCondition(
                        type=cond_data.get("type", "exact"),
                        field=cond_data.get("field"),
                        fields=cond_data.get("fields"),
                        tolerance_days=cond_data.get("tolerance_days"),
                        similarity=cond_data.get("similarity"),
                        overlap_ratio=cond_data.get("overlap_ratio"),
                        description=cond_data.get("description"),
                    ))
                possible_rules.append(DuplicateRule(
                    rule_id=rule_data.get("rule_id", ""),
                    description=rule_data.get("description", ""),
                    conditions=conditions,
                    severity=rule_data.get("severity", "warning"),
                ))
            
            duplicates[entity] = DuplicateDefinition(
                likely=likely_rules,
                possible=possible_rules,
            )
        
        logger.info(f"Loaded schema from YAML: {len(entities)} entities, {len(duplicates)} duplicate definitions")
        return SchemaConfig(
            metadata=metadata,
            entities=entities,
            duplicates=duplicates,
        )
        
    except Exception as exc:
        logger.error(f"Failed to load schema from YAML: {exc}", exc_info=True)
        return SchemaConfig(
            metadata=SchemaMetadata(source="error", generated="runtime"),
            entities={},
            duplicates={},
        )


def _convert_firestore_rules_to_schema_config(rules_data: Dict[str, Any]) -> SchemaConfig:
    """Convert Firestore rules structure to SchemaConfig format.

    Args:
        rules_data: Dictionary from RulesService.get_all_rules()

    Returns:
        SchemaConfig instance built from Firestore rules
    """
    # Build entities dict
    entities: Dict[str, EntitySchema] = {}

    # Get all entity names from relationships, required_fields, and value_checks
    all_entities = set()
    if "relationships" in rules_data:
        all_entities.update(rules_data["relationships"].keys())
    if "required_fields" in rules_data:
        all_entities.update(rules_data["required_fields"].keys())
    if "value_checks" in rules_data:
        all_entities.update(rules_data["value_checks"].keys())
    if "duplicates" in rules_data:
        all_entities.update(rules_data["duplicates"].keys())

    # Build entity schemas
    for entity in all_entities:
        # Get relationships for this entity
        relationships: Dict[str, RelationshipRule] = {}
        if "relationships" in rules_data and entity in rules_data["relationships"]:
            for rel_key, rel_data in rules_data["relationships"][entity].items():
                relationships[rel_key] = RelationshipRule(
                    target=rel_data.get("target", ""),
                    message=rel_data.get("message", ""),
                    min_links=rel_data.get("min_links", 0),
                    max_links=rel_data.get("max_links"),
                    require_active=rel_data.get("require_active", False),
                    allow_secondary=rel_data.get("allow_secondary", False),
                    condition_field=rel_data.get("condition_field"),
                    condition_value=rel_data.get("condition_value"),
                    notes=rel_data.get("notes"),
                    validate_bidirectional=rel_data.get("validate_bidirectional", False),
                    reverse_relationship_key=rel_data.get("reverse_relationship_key"),
                    cross_entity_validation=rel_data.get("cross_entity_validation"),
                )

        # Get required fields for this entity
        missing_key_data: List[FieldRequirement] = []
        if "required_fields" in rules_data and entity in rules_data["required_fields"]:
            for req_data in rules_data["required_fields"][entity]:
                # Prefer field_id over field when both are present (field_id is more reliable)
                field_reference = req_data.get("field_id") or req_data.get("field", "")
                
                # Include rule_id in FieldRequirement
                missing_key_data.append(FieldRequirement(
                    field=field_reference,
                    message=req_data.get("message", ""),
                    severity=req_data.get("severity", "warning"),
                    alternate_fields=req_data.get("alternate_fields"),
                    condition_field=req_data.get("condition_field"),
                    condition_value=req_data.get("condition_value"),
                    rule_id=req_data.get("rule_id"),  # Now part of the model
                ))

        # Get value checks for this entity
        value_checks: List[ValueCheck] = []
        if "value_checks" in rules_data and entity in rules_data["value_checks"]:
            for check_data in rules_data["value_checks"][entity]:
                # Prefer field_id over field when both are present (field_id is more reliable)
                field_reference = check_data.get("field_id") or check_data.get("field", "")
                
                # Include rule_id and source_entity in ValueCheck
                value_checks.append(ValueCheck(
                    field=field_reference,
                    message=check_data.get("message", ""),
                    severity=check_data.get("severity", "info"),
                    rule_id=check_data.get("rule_id"),
                    source_entity=check_data.get("source_entity"),
                    condition_field=check_data.get("condition_field"),
                    condition_value=check_data.get("condition_value"),
                ))

        entities[entity] = EntitySchema(
            description=f"{entity.capitalize()} entity",
            key_identifiers=[],  # Not stored in Firestore rules
            identity_fields=[],  # Not stored in Firestore rules
            relationships=relationships,
            missing_key_data=missing_key_data,
            value_checks=value_checks,
        )

    # Build duplicates dict
    duplicates: Dict[str, DuplicateDefinition] = {}
    if "duplicates" in rules_data:
        for entity, dup_data in rules_data["duplicates"].items():
            likely_rules: List[DuplicateRule] = []
            possible_rules: List[DuplicateRule] = []

            # Process likely duplicates
            if "likely" in dup_data:
                for rule_data in dup_data["likely"]:
                    conditions = []
                    for cond_data in rule_data.get("conditions", []):
                        # Map match_type to type (Firestore uses match_type, model uses type)
                        cond_type = cond_data.get("match_type") or cond_data.get("type", "exact")
                        conditions.append(DuplicateCondition(
                            type=cond_type,
                            field=cond_data.get("field"),
                            fields=cond_data.get("fields"),
                            tolerance_days=cond_data.get("tolerance_days"),
                            similarity=cond_data.get("similarity"),
                            overlap_ratio=cond_data.get("overlap_ratio"),
                            description=cond_data.get("description"),
                        ))
                    # Ensure rule_id is never empty - use _doc_id as fallback if rule_id is missing/empty
                    rule_id = rule_data.get("rule_id") or rule_data.get("_doc_id", "")
                    if not rule_id:
                        logger.warning(
                            f"Duplicate rule for {entity} has no rule_id or _doc_id",
                            extra={"rule_data_keys": list(rule_data.keys())}
                        )
                    likely_rules.append(DuplicateRule(
                        rule_id=rule_id,
                        description=rule_data.get("description", ""),
                        conditions=conditions,
                        severity=rule_data.get("severity", "warning"),
                    ))

            # Process possible duplicates
            if "possible" in dup_data:
                for rule_data in dup_data["possible"]:
                    conditions = []
                    for cond_data in rule_data.get("conditions", []):
                        # Map match_type to type (Firestore uses match_type, model uses type)
                        cond_type = cond_data.get("match_type") or cond_data.get("type", "exact")
                        conditions.append(DuplicateCondition(
                            type=cond_type,
                            field=cond_data.get("field"),
                            fields=cond_data.get("fields"),
                            tolerance_days=cond_data.get("tolerance_days"),
                            similarity=cond_data.get("similarity"),
                            overlap_ratio=cond_data.get("overlap_ratio"),
                            description=cond_data.get("description"),
                        ))
                    # Ensure rule_id is never empty - use _doc_id as fallback if rule_id is missing/empty
                    rule_id = rule_data.get("rule_id") or rule_data.get("_doc_id", "")
                    if not rule_id:
                        logger.warning(
                            f"Duplicate rule for {entity} has no rule_id or _doc_id",
                            extra={"rule_data_keys": list(rule_data.keys())}
                        )
                    possible_rules.append(DuplicateRule(
                        rule_id=rule_id,
                        description=rule_data.get("description", ""),
                        conditions=conditions,
                        severity=rule_data.get("severity", "warning"),
                    ))

            duplicates[entity] = DuplicateDefinition(
                likely=likely_rules,
                possible=possible_rules,
            )

    return SchemaConfig(
        metadata=SchemaMetadata(
            source="firestore",
            generated="runtime",
        ),
        entities=entities,
        duplicates=duplicates,
    )


def load_schema_config(
    path: Optional[Path] = None,
    firestore_client: Optional[Any] = None,
) -> SchemaConfig:
    """Load the schema config from Firestore rules.

    IMPORTANT: This function now loads ONLY from Firestore using the RulesService.
    It no longer loads from YAML to ensure that deleted rules don't persist.

    Args:
        path: DEPRECATED - No longer used. Kept for backward compatibility.
        firestore_client: Optional FirestoreClient for loading rules.

    Returns:
        SchemaConfig instance built from Firestore rules.
    """
    # Load rules from Firestore using RulesService
    if firestore_client:
        try:
            from ..services.rules_service import RulesService

            rules_service = RulesService(firestore_client)
            rules_data = rules_service.get_all_rules()

            # Log summary of loaded rules
            duplicates_count = sum(
                len(d.get("likely", [])) + len(d.get("possible", []))
                for d in rules_data.get("duplicates", {}).values()
            )
            relationships_count = sum(
                len(r) for r in rules_data.get("relationships", {}).values()
            )
            required_fields_count = sum(
                len(r) for r in rules_data.get("required_fields", {}).values()
            )
            
            logger.info(
                "Loaded schema config from Firestore rules",
                extra={
                    "duplicates_count": duplicates_count,
                    "relationships_count": relationships_count,
                    "required_fields_count": required_fields_count,
                    "duplicates_entities": list(rules_data.get("duplicates", {}).keys()),
                    "relationships_entities": list(rules_data.get("relationships", {}).keys()),
                    "required_fields_entities": list(rules_data.get("required_fields", {}).keys()),
                }
            )
            return _convert_firestore_rules_to_schema_config(rules_data)
        except Exception as exc:
            logger.error(f"Failed to load schema from Firestore: {exc}", exc_info=True)
            # Fall back to empty schema rather than YAML
            logger.warning("Falling back to empty schema config")
            return SchemaConfig(
                metadata=SchemaMetadata(
                    source="firestore-fallback",
                    generated="runtime",
                ),
                entities={},
                duplicates={},
            )

    # If no firestore_client provided, return empty schema
    logger.warning("No Firestore client provided, returning empty schema config")
    return SchemaConfig(
        metadata=SchemaMetadata(
            source="empty",
            generated="runtime",
        ),
        entities={},
        duplicates={},
    )
