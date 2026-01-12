"""Service for managing rules using the new rules/ collection structure."""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from google.cloud import firestore

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

logger = logging.getLogger(__name__)


class RulesService:
    """Service for managing integrity rules from new rules/ collection."""

    def __init__(self):
        """Initialize rules service with direct Firestore client."""
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

                for doc in docs:
                    rule_data = doc.to_dict()
                    # Add the document ID as rule_id if not present
                    if "rule_id" not in rule_data:
                        rule_data["rule_id"] = doc.id

                    severity = rule_data.get("severity", "likely")
                    if severity == "likely":
                        likely.append(rule_data)
                    else:
                        possible.append(rule_data)

                if likely or possible:
                    duplicates[entity] = {
                        "likely": likely,
                        "possible": possible,
                    }
            except Exception as exc:
                logger.warning(f"Failed to load duplicates for {entity}: {exc}")

        return duplicates

    def _load_relationships_from_firestore(self) -> Dict[str, Any]:
        """Load relationship rules from rules/relationships/{entity}/* collections."""
        if not self.db:
            return {}

        relationships = {}

        # Query each entity collection
        entities = ["students", "parents", "contractors"]

        for entity in entities:
            collection_path = f"rules/relationships/{entity}"
            try:
                docs = self.db.collection(collection_path).where("enabled", "==", True).stream()

                entity_rels = {}
                for doc in docs:
                    rule_data = doc.to_dict()
                    # Use document ID as the relationship key
                    entity_rels[doc.id] = rule_data

                if entity_rels:
                    relationships[entity] = entity_rels
            except Exception as exc:
                logger.warning(f"Failed to load relationships for {entity}: {exc}")

        return relationships

    def _load_required_fields_from_firestore(self) -> Dict[str, Any]:
        """Load required field rules from rules/required_fields/{entity}/* collections."""
        if not self.db:
            return {}

        required_fields = {}

        # Query each entity collection
        entities = ["students", "parents", "contractors"]

        for entity in entities:
            collection_path = f"rules/required_fields/{entity}"
            try:
                docs = self.db.collection(collection_path).where("enabled", "==", True).stream()

                fields = []
                for doc in docs:
                    rule_data = doc.to_dict()
                    # Add the document ID as rule_id if not present
                    if "rule_id" not in rule_data:
                        rule_data["rule_id"] = doc.id
                    fields.append(rule_data)

                if fields:
                    required_fields[entity] = fields
            except Exception as exc:
                logger.warning(f"Failed to load required fields for {entity}: {exc}")

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

        # Check if it's a YAML-sourced rule
        rule_data = doc.to_dict()
        if rule_data.get("source") == "yaml":
            raise ValueError(f"Cannot delete YAML-sourced rule {rule_id}. Use sync to manage YAML rules.")

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
