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

    def _load_duplicates_from_firestore(self) -> Dict[str, Any]:
        """Load duplicate rules from rules/duplicates/{entity}/* collections."""
        if not self.db:
            return {}

        duplicates = {}

        # Query each entity collection
        entities = ["students", "parents", "contractors"]

        for entity in entities:
            collection_path = f"rules/duplicates/{entity}"
            try:
                docs = self.db.collection(collection_path).where("enabled", "==", True).stream()

                likely = []
                possible = []
                likely_rule_ids = []
                possible_rule_ids = []

                for doc in docs:
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

                if likely or possible:
                    duplicates[entity] = {
                        "likely": likely,
                        "possible": possible,
                    }
                    logger.info(
                        f"Loaded duplicate rules for {entity}",
                        extra={
                            "category": "duplicates",
                            "entity": entity,
                            "likely_count": len(likely),
                            "possible_count": len(possible),
                            "likely_rule_ids": likely_rule_ids,
                            "possible_rule_ids": possible_rule_ids,
                        }
                    )
            except Exception as exc:
                logger.warning(f"Failed to load duplicates for {entity}: {exc}")

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

        # Query each entity collection
        entities = ["students", "parents", "contractors", "classes", "attendance", "truth", "campuses", "payments"]

        for entity in entities:
            collection_path = f"rules/relationships/{entity}"
            try:
                docs = self.db.collection(collection_path).where("enabled", "==", True).stream()

                entity_rels = {}
                rel_keys = []
                for doc in docs:
                    rule_data = doc.to_dict()
                    # Use document ID as the relationship key
                    rel_key = doc.id
                    entity_rels[rel_key] = rule_data
                    rel_keys.append(rel_key)

                if entity_rels:
                    relationships[entity] = entity_rels
                    logger.info(
                        f"Loaded relationship rules for {entity}",
                        extra={
                            "category": "relationships",
                            "entity": entity,
                            "rule_count": len(entity_rels),
                            "relationship_keys": rel_keys,
                        }
                    )
            except Exception as exc:
                logger.warning(f"Failed to load relationships for {entity}: {exc}")

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

        # Query each entity collection
        entities = ["students", "parents", "contractors", "classes", "attendance", "truth", "campuses", "payments"]

        for entity in entities:
            collection_path = f"rules/required_fields/{entity}"
            try:
                docs = self.db.collection(collection_path).where("enabled", "==", True).stream()

                fields = []
                rule_ids = []
                for doc in docs:
                    rule_data = doc.to_dict()
                    # Always use document ID as rule_id to ensure consistency
                    # This ensures deletion works correctly
                    rule_id = doc.id
                    rule_data["rule_id"] = rule_id
                    fields.append(rule_data)
                    rule_ids.append(rule_id)

                if fields:
                    required_fields[entity] = fields
                    logger.info(
                        f"Loaded required field rules for {entity}",
                        extra={
                            "category": "required_fields",
                            "entity": entity,
                            "rule_count": len(fields),
                            "rule_ids": rule_ids,
                        }
                    )
            except Exception as exc:
                logger.warning(f"Failed to load required fields for {entity}: {exc}")

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

        return {
            "duplicates": self._load_duplicates_from_firestore(),
            "relationships": self._load_relationships_from_firestore(),
            "required_fields": self._load_required_fields_from_firestore(),
            "attendance_rules": self._load_attendance_from_firestore(),
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
                rule_data["field"] = field_id_override
                logger.info(f"Using provided field_id: {field_id_override}")
            else:
                # Validate and normalize the field reference
                validation = self._validate_and_normalize_field_reference(field_ref, entity)
                rule_data["field"] = validation["field"]
                
                # Store field_id if found
                if validation["field_id"]:
                    rule_data["field_id"] = validation["field_id"]
                
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
        """Generate a unique rule ID."""
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")

        if category == "duplicates":
            desc = rule_data.get("description", "custom").lower().replace(" ", "_")[:20]
            return f"dup.{entity}.{desc}_{timestamp}"
        elif category == "relationships":
            target = rule_data.get("target", "unknown")
            return f"{entity}_{target}_{timestamp}"
        elif category == "required_fields":
            field = rule_data.get("field", "unknown")
            return f"{entity}_{field}_{timestamp}"
        elif category == "attendance_rules":
            metric = rule_data.get("metric", "custom")
            return f"{metric}_{timestamp}"

        return f"{category}_{entity}_{timestamp}"
