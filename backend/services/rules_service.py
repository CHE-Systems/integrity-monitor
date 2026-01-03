"""Service for managing rules using the new rules/ collection structure.

IMPORTANT: Before creating or modifying rules, consult docs/rules.md for:
- Field reference formats (IDs vs names)
- Schema snapshot requirements
- Rule structure and best practices
- Troubleshooting common issues

The field ID/name resolution system must be understood to avoid rule failures.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from google.cloud import firestore

from pathlib import Path
import json
import yaml
from ..config.config_loader import load_runtime_config
from ..config.models import (
    DuplicateDefinition,
    DuplicateRule,
    FieldRequirement,
    RelationshipRule,
    SchemaConfig,
)
from ..config.schema_loader import load_schema_config
from ..config.settings import AttendanceRules
from ..utils.records import _normalize_name

logger = logging.getLogger(__name__)


class RulesService:
    """Service for managing integrity rules from new rules/ collection."""

    def __init__(self, firestore_client=None):
        """Initialize rules service with direct Firestore client.

        Args:
            firestore_client: Optional FirestoreClient instance (not used, for backward compatibility)
        """
        try:
            self.db = firestore.Client()
        except Exception as exc:
            logger.error(f"Failed to initialize Firestore client: {exc}")
            self.db = None

    def _get_entities_from_mapping(self) -> List[str]:
        """Get list of entities from table_mapping.yaml dynamically."""
        try:
            mapping_path = Path(__file__).parent.parent / "config" / "table_mapping.yaml"
            if not mapping_path.exists():
                logger.warning(f"Table mapping file not found at {mapping_path}, using default entities")
                return ["students", "parents", "contractors"]
            
            with open(mapping_path, "r") as f:
                mapping_data = yaml.safe_load(f)
            
            entity_mapping = mapping_data.get("entity_table_mapping", {})
            entities = list(entity_mapping.keys())
            
            if entities:
                logger.info(f"Loaded {len(entities)} entities from table_mapping.yaml: {entities}")
                return entities
            else:
                logger.warning("No entities found in table_mapping.yaml, using default entities")
                return ["students", "parents", "contractors"]
        except Exception as exc:
            logger.warning(f"Failed to load entities from table_mapping.yaml: {exc}, using default entities", exc_info=True)
            return ["students", "parents", "contractors"]

    def _get_entity_variants(self, entity: str) -> List[str]:
        """Get both singular and plural variants of an entity name."""
        variants = [entity]
        # Common singular/plural mappings
        if entity.endswith('s'):
            # Plural -> singular
            variants.append(entity[:-1])
        else:
            # Singular -> plural
            variants.append(entity + 's')
        return list(set(variants))  # Remove duplicates

    def _load_duplicates_from_firestore(self) -> Dict[str, Any]:
        """Load duplicate rules from rules/duplicates/{entity}/* collections."""
        if not self.db:
            return {}

        duplicates = {}

        # Query each entity collection - dynamically discover entities
        entities = self._get_entities_from_mapping()

        for entity in entities:
            # Try both singular and plural forms
            entity_variants = self._get_entity_variants(entity)
            logger.debug(f"Checking entity '{entity}' with variants: {entity_variants}")
            
            for variant in entity_variants:
                collection_path = f"rules/duplicates/{variant}"
                try:
                    logger.info(f"Querying Firestore for duplicates: {collection_path}")
                    # First check if collection exists by trying to get all docs (no filter)
                    all_docs = list(self.db.collection(collection_path).stream())
                    if not all_docs:
                        logger.debug(f"Collection {collection_path} is empty or doesn't exist")
                        continue
                    
                    logger.info(f"Found {len(all_docs)} total document(s) in {collection_path}")
                    
                    # Check enabled status
                    enabled_docs = [d for d in all_docs if d.to_dict().get("enabled", True)]
                    disabled_docs = [d for d in all_docs if not d.to_dict().get("enabled", True)]
                    
                    if disabled_docs:
                        logger.warning(f"Found {len(disabled_docs)} disabled rule(s) in {collection_path}")
                    
                    # Now query with enabled filter (or include all if enabled field is missing)
                    docs = self.db.collection(collection_path).where("enabled", "==", True).stream()

                    likely = []
                    possible = []
                    likely_rule_ids = []
                    possible_rule_ids = []
                    
                    doc_count = 0
                    for doc in docs:
                        doc_count += 1
                        rule_data = doc.to_dict()
                        # Always ensure rule_id is set - use doc.id if missing or empty
                        if not rule_data.get("rule_id"):
                            rule_data["rule_id"] = doc.id
                        # Also store doc.id for reference (in case rule_id was empty and we need it later)
                        rule_data["_doc_id"] = doc.id

                        rule_id = rule_data["rule_id"]
                        severity = rule_data.get("severity", "likely")
                        if severity == "likely":
                            likely.append(rule_data)
                            likely_rule_ids.append(rule_id)
                        else:
                            possible.append(rule_data)
                            possible_rule_ids.append(rule_id)

                    logger.info(f"Found {doc_count} enabled documents in {collection_path} (likely: {len(likely)}, possible: {len(possible)})")
                    
                    if likely or possible:
                        # Use the canonical entity name (from mapping), not the variant
                        if entity not in duplicates:
                            duplicates[entity] = {"likely": [], "possible": []}
                        duplicates[entity]["likely"].extend(likely)
                        duplicates[entity]["possible"].extend(possible)
                        logger.info(
                            f"✅ Loaded duplicate rules for {entity} from {variant}",
                            extra={
                                "category": "duplicates",
                                "entity": entity,
                                "variant": variant,
                                "likely_count": len(likely),
                                "possible_count": len(possible),
                            }
                        )
                        break  # Found rules, no need to check other variants
                    else:
                        logger.debug(f"Collection {collection_path} exists but no enabled rules found")
                except Exception as exc:
                    logger.warning(f"❌ Failed to query {collection_path}: {exc}", exc_info=True)
                    continue
            
            # Log if no rules found for this entity
            if entity not in duplicates:
                logger.debug(f"No duplicate rules found for {entity} in any variant")

        total_likely = sum(len(d.get("likely", [])) for d in duplicates.values())
        total_possible = sum(len(d.get("possible", [])) for d in duplicates.values())
        if duplicates:
            logger.info(
                "Loaded duplicate rules from Firestore",
                extra={
                    "category": "duplicates",
                    "total_entities": len(duplicates),
                    "total_likely": total_likely,
                    "total_possible": total_possible,
                    "entities": list(duplicates.keys()),
                }
            )

        return duplicates

    def _load_relationships_from_firestore(self) -> Dict[str, Any]:
        """Load relationship rules from rules/relationships/{entity}/* collections."""
        if not self.db:
            return {}

        relationships = {}

        # Query each entity collection - dynamically discover entities
        entities = self._get_entities_from_mapping()

        for entity in entities:
            # Try both singular and plural forms
            entity_variants = self._get_entity_variants(entity)
            
            for variant in entity_variants:
                collection_path = f"rules/relationships/{variant}"
                try:
                    logger.debug(f"Querying Firestore for relationships: {collection_path}")
                    docs = self.db.collection(collection_path).where("enabled", "==", True).stream()

                    entity_rels = {}
                    rel_keys = []
                    doc_count = 0
                    for doc in docs:
                        doc_count += 1
                        rule_data = doc.to_dict()
                        # Use document ID as the relationship key
                        rel_key = doc.id
                        entity_rels[rel_key] = rule_data
                        rel_keys.append(rel_key)

                    logger.debug(f"Found {doc_count} documents in {collection_path}")
                    
                    if entity_rels:
                        # Use the canonical entity name (from mapping), not the variant
                        if entity not in relationships:
                            relationships[entity] = {}
                        relationships[entity].update(entity_rels)
                        logger.info(
                            f"Loaded relationship rules for {entity} from {variant}",
                            extra={
                                "category": "relationships",
                                "entity": entity,
                                "variant": variant,
                                "rule_count": len(entity_rels),
                            }
                        )
                        break  # Found rules, no need to check other variants
                except Exception as exc:
                    logger.debug(f"Failed to query {collection_path}: {exc}")
                    continue
            
            # Log if no rules found for this entity
            if entity not in relationships:
                logger.debug(f"No relationship rules found for {entity} in any variant")

        total_rules = sum(len(r) for r in relationships.values())
        if relationships:
            logger.info(
                "Loaded relationship rules from Firestore",
                extra={
                    "category": "relationships",
                    "total_entities": len(relationships),
                    "total_rules": total_rules,
                    "entities": list(relationships.keys()),
                }
            )

        return relationships

    def _load_required_fields_from_firestore(self) -> Dict[str, Any]:
        """Load required field rules from rules/required_fields/{entity}/* collections."""
        if not self.db:
            return {}

        required_fields = {}

        # Query each entity collection - dynamically discover entities
        entities = self._get_entities_from_mapping()

        for entity in entities:
            # Try both singular and plural forms
            entity_variants = self._get_entity_variants(entity)
            
            for variant in entity_variants:
                collection_path = f"rules/required_fields/{variant}"
                try:
                    logger.debug(f"Querying Firestore for required_fields: {collection_path}")
                    docs = self.db.collection(collection_path).where("enabled", "==", True).stream()

                    fields = []
                    rule_ids = []
                    doc_count = 0
                    for doc in docs:
                        doc_count += 1
                        rule_data = doc.to_dict()
                        # Always use document ID as rule_id to ensure consistency
                        # This ensures deletion works correctly
                        rule_id = doc.id
                        rule_data["rule_id"] = rule_id
                        fields.append(rule_data)
                        rule_ids.append(rule_id)

                    logger.debug(f"Found {doc_count} documents in {collection_path}")
                    
                    if fields:
                        # Use the canonical entity name (from mapping), not the variant
                        if entity not in required_fields:
                            required_fields[entity] = []
                        required_fields[entity].extend(fields)
                        logger.info(
                            f"Loaded required field rules for {entity} from {variant}",
                            extra={
                                "category": "required_fields",
                                "entity": entity,
                                "variant": variant,
                                "rule_count": len(fields),
                            }
                        )
                        break  # Found rules, no need to check other variants
                except Exception as exc:
                    logger.debug(f"Failed to query {collection_path}: {exc}")
                    continue
            
            # Log if no rules found for this entity
            if entity not in required_fields:
                logger.debug(f"No required field rules found for {entity} in any variant")

        total_rules = sum(len(r) for r in required_fields.values())
        entity_counts = {entity: len(rules) for entity, rules in required_fields.items()}
        if required_fields:
            logger.info(
                "Loaded required field rules from Firestore",
                extra={
                    "category": "required_fields",
                    "total_entities": len(required_fields),
                    "total_rules": total_rules,
                    "entity_counts": entity_counts,
                    "entities": list(required_fields.keys()),
                }
            )

        return required_fields

    def _load_attendance_from_firestore(self) -> Dict[str, Any]:
        """Load attendance rules from rules/attendance/* collections."""
        if not self.db:
            return {}

        attendance = {
            "onboarding_grace_days": 7,
            "limited_schedule_threshold": 3,
            "thresholds": {},
        }

        # Load config
        try:
            config_doc = self.db.collection("rules/attendance/config").document("settings").get()
            if config_doc.exists:
                config_data = config_doc.to_dict()
                if "onboarding_grace_days" in config_data:
                    attendance["onboarding_grace_days"] = config_data["onboarding_grace_days"]
                if "limited_schedule_threshold" in config_data:
                    attendance["limited_schedule_threshold"] = config_data["limited_schedule_threshold"]
        except Exception as exc:
            logger.warning(f"Failed to load attendance config: {exc}")

        # Load thresholds
        try:
            docs = self.db.collection("rules/attendance/thresholds").where("enabled", "==", True).stream()

            for doc in docs:
                threshold_data = doc.to_dict()
                metric = threshold_data.get("metric", doc.id)

                # Extract threshold values
                threshold = {}
                if "info" in threshold_data:
                    threshold["info"] = threshold_data["info"]
                if "warning" in threshold_data:
                    threshold["warning"] = threshold_data["warning"]
                if "critical" in threshold_data:
                    threshold["critical"] = threshold_data["critical"]

                if threshold:
                    attendance["thresholds"][metric] = threshold
        except Exception as exc:
            logger.warning(f"Failed to load attendance thresholds: {exc}")

        return attendance

    def get_all_rules(self) -> Dict[str, Any]:
        """Get all rules from the new rules/ collection structure.

        Returns:
            Dictionary with rule categories and their rules.
        """
        logger.info("Loading rules from Firestore rules/ collection")
        
        # Get entities to query
        entities = self._get_entities_from_mapping()
        logger.info(f"Querying rules for entities: {entities}")

        duplicates = self._load_duplicates_from_firestore()
        relationships = self._load_relationships_from_firestore()
        required_fields = self._load_required_fields_from_firestore()
        attendance_rules = self._load_attendance_from_firestore()
        
        # Log summary of what was loaded
        logger.info(
            "Rules loading summary",
            extra={
                "entities_queried": entities,
                "duplicates_entities": list(duplicates.keys()),
                "duplicates_counts": {k: {"likely": len(v.get("likely", [])), "possible": len(v.get("possible", []))} for k, v in duplicates.items()},
                "relationships_entities": list(relationships.keys()),
                "relationships_counts": {k: len(v) for k, v in relationships.items()},
                "required_fields_entities": list(required_fields.keys()),
                "required_fields_counts": {k: len(v) for k, v in required_fields.items()},
            }
        )
        
        # Also log a warning if we're missing expected entities
        expected_entities = ["students", "contractors", "parents"]
        missing_entities = {
            "duplicates": [e for e in expected_entities if e not in duplicates],
            "relationships": [e for e in expected_entities if e not in relationships],
            "required_fields": [e for e in expected_entities if e not in required_fields],
        }
        
        if any(missing_entities.values()):
            logger.warning(
                "Some expected entities have no rules",
                extra={
                    "missing_entities": missing_entities,
                    "hint": "Rules may be stored under different entity names or in different collections"
                }
            )

        return {
            "duplicates": duplicates,
            "relationships": relationships,
            "required_fields": required_fields,
            "attendance_rules": attendance_rules,
        }

    def get_rules_by_category(self, category: str) -> Dict[str, Any]:
        """Get rules for a specific category.

        Args:
            category: One of 'duplicates', 'relationships', 'required_fields', 'attendance_rules'

        Returns:
            Dictionary of rules for that category
        """
        if category == "duplicates":
            return self._load_duplicates_from_firestore()
        elif category == "relationships":
            return self._load_relationships_from_firestore()
        elif category == "required_fields":
            return self._load_required_fields_from_firestore()
        elif category == "attendance_rules":
            return self._load_attendance_from_firestore()
        else:
            raise ValueError(f"Unknown category: {category}")

    def _validate_and_normalize_field_reference(
        self, field_ref: str, entity: str, table_name: Optional[str] = None
    ) -> Dict[str, Any]:
        """Validate and normalize a field reference for a required field rule.
        
        Args:
            field_ref: Field ID (fld...) or field name
            entity: Entity name (e.g., "contractors")
            table_name: Optional table name for lookup (if None, will be inferred from entity)
            
        Returns:
            Dict with:
                - field: Normalized field reference (prefers field ID if both provided)
                - field_id: Field ID if found
                - field_name: Field name if found
                - valid: Whether field exists in schema
                - warning: Optional warning message
        """
        result = {
            "field": field_ref,
            "field_id": None,
            "field_name": None,
            "valid": False,
            "warning": None,
        }
        
        # If it's already a field ID, validate it exists
        if field_ref.startswith("fld") and len(field_ref) >= 14:
            result["field_id"] = field_ref
            result["field"] = field_ref
            
            # Try to resolve field ID to name
            schema_path = Path(__file__).resolve().parent.parent / "config" / "airtable_schema.json"
            try:
                with schema_path.open("r", encoding="utf-8") as f:
                    schema = json.load(f)
                
                # Find the table for this entity
                if not table_name:
                    # Try to infer table name from entity
                    entity_to_table = {
                        "contractors": "Contractors/Volunteers",
                        "students": "Students",
                        "parents": "Parents",
                        "classes": "Classes",
                    }
                    table_name = entity_to_table.get(entity, entity.title())
                
                # Find field by ID
                for table in schema.get("tables", []):
                    if table.get("name") == table_name or entity.lower() in table.get("name", "").lower():
                        for field in table.get("fields", []):
                            if field.get("id") == field_ref:
                                result["field_name"] = field.get("name")
                                result["valid"] = True
                                return result
                
                # Field ID not found in schema
                result["warning"] = f"Field ID {field_ref} not found in schema snapshot for {entity}"
                logger.warning(result["warning"])
            except Exception as exc:
                result["warning"] = f"Could not validate field ID: {exc}"
                logger.warning(result["warning"])
            
            # Assume valid if we can't verify (backward compatibility)
            result["valid"] = True
            return result
        
        # It's a field name - try to find the field ID
        schema_path = Path(__file__).resolve().parent.parent / "config" / "airtable_schema.json"
        try:
            with schema_path.open("r", encoding="utf-8") as f:
                schema = json.load(f)
            
            # Find the table for this entity
            if not table_name:
                entity_to_table = {
                    "contractors": "Contractors/Volunteers",
                    "students": "Students",
                    "parents": "Parents",
                    "classes": "Classes",
                }
                table_name = entity_to_table.get(entity, entity.title())
            
            normalized_field_name = _normalize_name(field_ref)
            
            # Find field by name (case-insensitive, normalized)
            for table in schema.get("tables", []):
                if table.get("name") == table_name or entity.lower() in table.get("name", "").lower():
                    for field in table.get("fields", []):
                        field_name = field.get("name", "")
                        if _normalize_name(field_name) == normalized_field_name or field_name == field_ref:
                            field_id = field.get("id")
                            if field_id:
                                result["field_id"] = field_id
                                result["field_name"] = field_name
                                result["field"] = field_id  # Prefer field ID
                                result["valid"] = True
                                
                                # Warn if name doesn't match exactly
                                if field_name != field_ref:
                                    result["warning"] = f"Field name '{field_ref}' matched '{field_name}' (using field ID {field_id})"
                                    logger.info(result["warning"])
                                return result
            
            # Field name not found
            result["warning"] = f"Field name '{field_ref}' not found in schema for {entity}. Rule may not work correctly."
            logger.warning(result["warning"])
        except Exception as exc:
            result["warning"] = f"Could not validate field name: {exc}"
            logger.warning(result["warning"])
        
        # Assume valid if we can't verify (backward compatibility)
        result["valid"] = True
        return result

    def create_rule(
        self,
        category: str,
        entity: Optional[str],
        rule_data: Dict[str, Any],
        user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Create a new rule in the rules/ collection.

        Args:
            category: Rule category ('duplicates', 'relationships', 'required_fields', 'attendance_rules')
            entity: Entity name (required for duplicates, relationships, required_fields)
            rule_data: Rule data dictionary
            user_id: Optional user ID for audit trail

        Returns:
            Created rule with generated ID
        """
        if not self.db:
            raise ValueError("Firestore client not available")

        # Validate and normalize field reference for required_fields rules
        if category == "required_fields" and entity and "field" in rule_data:
            field_ref = rule_data.get("field")
            field_id_override = rule_data.get("field_id")  # Allow manual field_id override
            
            # If both field and field_id are provided, prefer field_id
            if field_id_override:
                # Use field_id as the primary field reference (more reliable)
                rule_data["field"] = field_id_override
                # Keep field_id for reference, but field is now the primary
                rule_data["field_id"] = field_id_override
                
                # Try to resolve field name from field_id for display purposes
                validation = self._validate_and_normalize_field_reference(field_id_override, entity)
                if validation.get("field_name"):
                    rule_data["field_name"] = validation["field_name"]
                elif field_ref and not field_ref.startswith("fld"):
                    # Use original field_ref as field_name if it was a name
                    rule_data["field_name"] = field_ref
                
                logger.info(
                    f"Using provided field_id as primary field reference: {field_id_override}",
                    extra={
                        "entity": entity,
                        "original_field": field_ref,
                        "field_id": field_id_override,
                        "field_name": rule_data.get("field_name"),
                    }
                )
            else:
                # Validate and normalize the field reference
                validation = self._validate_and_normalize_field_reference(field_ref, entity)
                
                # Prefer field_id if found, otherwise use normalized field name
                if validation["field_id"]:
                    rule_data["field"] = validation["field_id"]
                    rule_data["field_id"] = validation["field_id"]
                    # Store field_name for display and rule ID generation
                    if validation.get("field_name"):
                        rule_data["field_name"] = validation["field_name"]
                    else:
                        # Use original field_ref as field_name if validation didn't find it
                        rule_data["field_name"] = field_ref
                    logger.info(
                        f"Auto-resolved field_id from field name: {field_ref} -> {validation['field_id']}",
                        extra={
                            "entity": entity,
                            "original_field": field_ref,
                            "field_id": validation["field_id"],
                            "field_name": validation.get("field_name") or field_ref,
                        }
                    )
                else:
                    # No field_id found, use the field name (may be less reliable)
                    rule_data["field"] = validation["field"]
                    rule_data["field_name"] = validation["field"]  # Use normalized field name
                    logger.warning(
                        f"Could not resolve field_id for field '{field_ref}', using field name. Rule may be less reliable.",
                        extra={
                            "entity": entity,
                            "original_field": field_ref,
                            "normalized_field": validation["field"],
                        }
                    )
                
                # Log warnings
                if validation["warning"]:
                    logger.warning(
                        f"Field validation warning for {entity}: {validation['warning']}",
                        extra={
                            "entity": entity,
                            "original_field": field_ref,
                            "normalized_field": validation["field"],
                            "warning": validation["warning"],
                        }
                    )

        # Generate rule ID if not provided
        if "rule_id" not in rule_data:
            rule_data["rule_id"] = self._generate_rule_id(category, entity, rule_data)

        rule_id = rule_data["rule_id"]

        # Add metadata
        rule_data.update({
            "source": "user",
            "enabled": True,
            "created_at": datetime.now(timezone.utc),
            "updated_at": datetime.now(timezone.utc),
            "created_by": user_id or "system",
            "updated_by": user_id or "system",
        })

        # Determine collection path and save
        if category == "duplicates":
            if not entity:
                raise ValueError("Entity required for duplicate rules")
            collection_path = f"rules/duplicates/{entity}"
            rule_data["entity"] = entity
            rule_data["severity"] = rule_data.get("severity", rule_data.get("confidence", "likely"))
        elif category == "relationships":
            if not entity:
                raise ValueError("Entity required for relationship rules")
            collection_path = f"rules/relationships/{entity}"
            rule_data["source_entity"] = entity
        elif category == "required_fields":
            if not entity:
                raise ValueError("Entity required for required field rules")
            collection_path = f"rules/required_fields/{entity}"
            rule_data["entity"] = entity
        elif category == "attendance_rules":
            # For attendance, save to thresholds collection
            collection_path = "rules/attendance/thresholds"
            if "metric" in rule_data:
                rule_id = rule_data["metric"]
        else:
            raise ValueError(f"Unknown category: {category}")

        # Save to Firestore
        self.db.collection(collection_path).document(rule_id).set(rule_data)
        logger.info(f"Created rule {rule_id} in {collection_path}")

        return rule_data

    def update_rule(
        self,
        category: str,
        entity: Optional[str],
        rule_id: str,
        rule_data: Dict[str, Any],
        user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Update an existing rule in the rules/ collection.

        Args:
            category: Rule category
            entity: Entity name (required for duplicates, relationships, required_fields)
            rule_id: Rule ID to update
            rule_data: Updated rule data
            user_id: Optional user ID for audit trail

        Returns:
            Updated rule
        """
        if not self.db:
            raise ValueError("Firestore client not available")

        # For required_fields rules, if field_name is updated, regenerate rule_id
        new_rule_id = rule_id
        if category == "required_fields" and entity and "field_name" in rule_data:
            # Generate new rule_id based on updated field_name
            new_rule_id = self._generate_rule_id(category, entity, rule_data)
            rule_data["rule_id"] = new_rule_id
            # Note: If rule_id changed, the document ID in Firestore won't change automatically
            # For now, we'll update the rule_id in the data but keep the same document ID

        # Determine collection path
        if category == "duplicates":
            if not entity:
                raise ValueError("Entity required for duplicate rules")
            collection_path = f"rules/duplicates/{entity}"
        elif category == "relationships":
            if not entity:
                raise ValueError("Entity required for relationship rules")
            collection_path = f"rules/relationships/{entity}"
        elif category == "required_fields":
            if not entity:
                raise ValueError("Entity required for required field rules")
            collection_path = f"rules/required_fields/{entity}"
        elif category == "attendance_rules":
            collection_path = "rules/attendance/thresholds"
        else:
            raise ValueError(f"Unknown category: {category}")

        # Get existing rule
        doc_ref = self.db.collection(collection_path).document(rule_id)
        doc = doc_ref.get()

        if not doc.exists:
            raise ValueError(f"Rule {rule_id} not found in {collection_path}")

        # Merge with existing data and update metadata
        existing_data = doc.to_dict()
        updated_data = {
            **existing_data,
            **rule_data,
            "updated_at": datetime.now(timezone.utc),
            "updated_by": user_id or "system",
        }

        # Save to Firestore
        doc_ref.update(updated_data)
        logger.info(f"Updated rule {rule_id} in {collection_path}")

        return updated_data

    def delete_rule(
        self,
        category: str,
        entity: Optional[str],
        rule_id: str,
        user_id: Optional[str] = None,
    ) -> None:
        """Delete a rule from the rules/ collection.

        Args:
            category: Rule category
            entity: Entity name (required for duplicates, relationships, required_fields)
            rule_id: Rule ID to delete
            user_id: Optional user ID for audit trail
        """
        if not self.db:
            raise ValueError("Firestore client not available")

        # Determine collection path
        if category == "duplicates":
            if not entity:
                raise ValueError("Entity required for duplicate rules")
            collection_path = f"rules/duplicates/{entity}"
        elif category == "relationships":
            if not entity:
                raise ValueError("Entity required for relationship rules")
            collection_path = f"rules/relationships/{entity}"
        elif category == "required_fields":
            if not entity:
                raise ValueError("Entity required for required field rules")
            collection_path = f"rules/required_fields/{entity}"
        elif category == "attendance_rules":
            collection_path = "rules/attendance/thresholds"
        else:
            raise ValueError(f"Unknown category: {category}")

        # Delete from Firestore
        doc_ref = self.db.collection(collection_path).document(rule_id)
        doc = doc_ref.get()

        if not doc.exists:
            raise ValueError(f"Rule {rule_id} not found in {collection_path}")

        # Allow deletion of all rules (YAML-sourced rules can now be deleted from Firestore)
        # Note: This doesn't affect the YAML source files, only the Firestore copy
        doc_ref.delete()
        logger.info(f"Deleted rule {rule_id} from {collection_path}")

    def _generate_rule_id(self, category: str, entity: Optional[str], rule_data: Dict[str, Any]) -> str:
        """Generate a unique rule ID.
        
        Format for required_fields: required_field_rule.{entity}.{field_name}
        This makes rule IDs human-readable and allows field_name to be editable.
        """
        if category == "required_fields":
            # Use field_name if available (for display), otherwise fall back to field
            field_name = rule_data.get("field_name") or rule_data.get("field", "unknown")
            
            # If field_name is a field ID (fld...), try to resolve it to a name
            if field_name.startswith("fld") and len(field_name) >= 14:
                # Try to get field name from validation
                validation = self._validate_and_normalize_field_reference(field_name, entity or "")
                if validation.get("field_name"):
                    field_name = validation["field_name"]
                else:
                    # Fall back to a sanitized version of the field ID
                    field_name = f"field_{field_name[-8:]}"  # Use last 8 chars of ID
            
            # Sanitize field_name for use in rule ID (lowercase, replace spaces/special chars with underscores)
            field_name_safe = field_name.lower().replace(" ", "_").replace("-", "_").replace("/", "_")
            # Remove any remaining special characters
            import re
            field_name_safe = re.sub(r'[^a-z0-9_]', '', field_name_safe)
            # Limit length
            field_name_safe = field_name_safe[:50]
            
            return f"required_field_rule.{entity}.{field_name_safe}"
        elif category == "duplicates":
            desc = rule_data.get("description", "custom").lower().replace(" ", "_")[:20]
            return f"dup.{entity}.{desc}"
        elif category == "relationships":
            target = rule_data.get("target", "unknown")
            return f"link.{entity}.{target}"
        elif category == "attendance_rules":
            metric = rule_data.get("metric", "custom")
            return f"attendance.{metric}"

        return f"{category}.{entity}.custom"
