#!/usr/bin/env python3
"""
Rules Migration Script

Migrates rules from YAML files to Firestore.

Actions:
- migrate: Load all YAML rules into Firestore (initial migration)
- sync: Sync YAML changes to Firestore (preserve user-created rules)
- reset: Delete all Firestore rules and reload from YAML
- clear: Delete all Firestore rules

Usage:
    python -m backend.scripts.migrate_rules --action=migrate [--dry-run]
    python -m backend.scripts.migrate_rules --action=sync
    python -m backend.scripts.migrate_rules --action=reset --confirm
    python -m backend.scripts.migrate_rules --action=clear --confirm
"""

#!/usr/bin/env python3
import argparse
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Tuple

# Add project root to path
project_root = Path(__file__).parent.parent.parent
sys.path.insert(0, str(project_root))

# Now we can import backend modules
from backend.config.schema_loader import load_schema_config, load_schema_from_yaml
from backend.config.config_loader import load_runtime_config
from backend.config.settings import FirestoreConfig


class RulesMigrator:
    """Handles migration of rules from YAML to Firestore."""

    def __init__(self, dry_run: bool = False):
        self.dry_run = dry_run

        # Initialize Firestore client directly
        try:
            from google.cloud import firestore
            self.db = firestore.Client()
        except Exception as e:
            print(f"❌ Error initializing Firestore: {e}")
            print("\nMake sure you have:")
            print("1. Installed google-cloud-firestore: pip install google-cloud-firestore")
            print("2. Set up credentials:")
            print("   - gcloud auth application-default login")
            print("   - OR set GOOGLE_APPLICATION_CREDENTIALS environment variable")
            raise

        # Load configs from YAML (without Firestore overrides)
        print("Loading YAML configurations...")
        self.schema_config = load_schema_from_yaml()
        self.runtime_config = load_runtime_config(firestore_client=None)

        # Statistics
        self.stats = {
            "duplicates": {"created": 0, "updated": 0, "deleted": 0, "preserved": 0},
            "relationships": {"created": 0, "updated": 0, "deleted": 0, "preserved": 0},
            "required_fields": {"created": 0, "updated": 0, "deleted": 0, "preserved": 0},
            "attendance": {"created": 0, "updated": 0, "deleted": 0, "preserved": 0},
        }

    def migrate(self) -> None:
        """Initial migration: Load all YAML rules into Firestore."""
        print("\n" + "=" * 70)
        print("RULES MIGRATION: YAML → Firestore")
        print("=" * 70)

        if self.dry_run:
            print("\n🔍 DRY RUN MODE - No changes will be made\n")

        # Migrate each category
        self._migrate_duplicates()
        self._migrate_relationships()
        self._migrate_required_fields()
        self._migrate_attendance()

        # Print summary
        self._print_summary()

    def sync(self) -> None:
        """Sync YAML changes to Firestore (preserve user rules)."""
        print("\n" + "=" * 70)
        print("RULES SYNC: Update Firestore with YAML changes")
        print("=" * 70)
        print("\n📝 User-created rules will be preserved\n")

        if self.dry_run:
            print("🔍 DRY RUN MODE - No changes will be made\n")

        # Clean up old format rules first
        self._cleanup_old_format_rules()
        
        # Clean up rules that are no longer in YAML
        self._cleanup_removed_rules()

        # Sync each category
        self._sync_duplicates()
        self._sync_relationships()
        self._sync_required_fields()
        self._sync_attendance()

        # Print summary
        self._print_summary()

    def reset(self) -> None:
        """Reset: Delete all Firestore rules and reload from YAML."""
        print("\n" + "=" * 70)
        print("RULES RESET: Delete Firestore rules and reload from YAML")
        print("=" * 70)
        print("\n⚠️  WARNING: This will delete ALL rules in Firestore!\n")

        if self.dry_run:
            print("🔍 DRY RUN MODE - No changes will be made\n")

        # Delete all rules
        self._delete_all_rules()

        # Reload from YAML
        self._migrate_duplicates()
        self._migrate_relationships()
        self._migrate_required_fields()
        self._migrate_attendance()

        # Print summary
        self._print_summary()

    def clear(self) -> None:
        """Clear: Delete all Firestore rules."""
        print("\n" + "=" * 70)
        print("RULES CLEAR: Delete all Firestore rules")
        print("=" * 70)
        print("\n⚠️  WARNING: This will delete ALL rules in Firestore!\n")

        if self.dry_run:
            print("🔍 DRY RUN MODE - No changes will be made\n")

        self._delete_all_rules()
        self._print_summary()

    # ========================================================================
    # DUPLICATE RULES MIGRATION
    # ========================================================================

    def _migrate_duplicates(self) -> None:
        """Migrate duplicate rules from YAML to Firestore."""
        print("\n📋 Migrating Duplicate Rules...")

        if not self.schema_config.duplicates:
            print("   No duplicate rules found in YAML")
            return

        for entity, dup_def in self.schema_config.duplicates.items():
            print(f"\n   Entity: {entity}")

            # Migrate likely duplicates
            for idx, rule in enumerate(dup_def.likely or []):
                rule_id = rule.rule_id or f"dup.{entity}.likely.{idx:03d}"
                self._create_duplicate_rule(entity, "likely", rule_id, rule)

            # Migrate possible duplicates
            for idx, rule in enumerate(dup_def.possible or []):
                rule_id = rule.rule_id or f"dup.{entity}.possible.{idx:03d}"
                self._create_duplicate_rule(entity, "possible", rule_id, rule)

    def _create_duplicate_rule(
        self, entity: str, severity: str, rule_id: str, rule: Any
    ) -> None:
        """Create a single duplicate rule in Firestore."""
        collection_path = f"rules/duplicates/{entity}"

        # Convert conditions to dict
        conditions = []
        for cond in rule.conditions:
            cond_dict = {
                "type": cond.type,
            }
            if hasattr(cond, "field") and cond.field:
                cond_dict["field"] = cond.field
            if hasattr(cond, "fields") and cond.fields:
                cond_dict["fields"] = cond.fields
            if hasattr(cond, "tolerance_days") and cond.tolerance_days is not None:
                cond_dict["tolerance_days"] = cond.tolerance_days
            if hasattr(cond, "similarity") and cond.similarity is not None:
                cond_dict["similarity"] = cond.similarity
            if hasattr(cond, "overlap_ratio") and cond.overlap_ratio is not None:
                cond_dict["overlap_ratio"] = cond.overlap_ratio
            conditions.append(cond_dict)

        doc_data = {
            "rule_id": rule_id,
            "entity": entity,
            "description": rule.description or "",
            "severity": severity,
            "conditions": conditions,
            "source": "yaml",
            "enabled": True,
            "created_at": datetime.now(timezone.utc),
            "updated_at": datetime.now(timezone.utc),
            "created_by": "system",
            "updated_by": "system",
        }

        if self.dry_run:
            print(f"      [DRY RUN] Would create: {rule_id} ({severity})")
        else:
            self.db.collection(collection_path).document(rule_id).set(doc_data)
            print(f"      ✅ Created: {rule_id} ({severity})")

        self.stats["duplicates"]["created"] += 1

    def _sync_duplicates(self) -> None:
        """Sync duplicate rules from YAML (preserve user rules)."""
        print("\n📋 Syncing Duplicate Rules...")

        if not self.schema_config.duplicates:
            print("   No duplicate rules found in YAML")
            return

        for entity, dup_def in self.schema_config.duplicates.items():
            print(f"\n   Entity: {entity}")

            # Get existing rules
            collection_path = f"rules/duplicates/{entity}"
            existing_docs = self.db.collection(collection_path).stream()
            existing_rules = {doc.id: doc.to_dict() for doc in existing_docs}

            # Track YAML rule IDs
            yaml_rule_ids = set()

            # Sync likely duplicates
            for idx, rule in enumerate(dup_def.likely or []):
                rule_id = rule.rule_id or f"dup.{entity}.likely.{idx:03d}"
                yaml_rule_ids.add(rule_id)

                if rule_id in existing_rules:
                    existing = existing_rules[rule_id]
                    if existing.get("source") == "yaml":
                        self._update_duplicate_rule(entity, "likely", rule_id, rule)
                    else:
                        print(f"      ⏭️  Preserved user rule: {rule_id}")
                        self.stats["duplicates"]["preserved"] += 1
                else:
                    self._create_duplicate_rule(entity, "likely", rule_id, rule)

            # Sync possible duplicates
            for idx, rule in enumerate(dup_def.possible or []):
                rule_id = rule.rule_id or f"dup.{entity}.possible.{idx:03d}"
                yaml_rule_ids.add(rule_id)

                if rule_id in existing_rules:
                    existing = existing_rules[rule_id]
                    if existing.get("source") == "yaml":
                        self._update_duplicate_rule(entity, "possible", rule_id, rule)
                    else:
                        print(f"      ⏭️  Preserved user rule: {rule_id}")
                        self.stats["duplicates"]["preserved"] += 1
                else:
                    self._create_duplicate_rule(entity, "possible", rule_id, rule)

            # Delete YAML rules that no longer exist
            for rule_id, rule_data in existing_rules.items():
                if rule_data.get("source") == "yaml" and rule_id not in yaml_rule_ids:
                    self._delete_rule(collection_path, rule_id, "duplicates")

    def _update_duplicate_rule(
        self, entity: str, severity: str, rule_id: str, rule: Any
    ) -> None:
        """Update an existing duplicate rule."""
        collection_path = f"rules/duplicates/{entity}"

        # Convert conditions
        conditions = []
        for cond in rule.conditions:
            cond_dict = {"type": cond.type}
            if hasattr(cond, "field") and cond.field:
                cond_dict["field"] = cond.field
            if hasattr(cond, "fields") and cond.fields:
                cond_dict["fields"] = cond.fields
            if hasattr(cond, "tolerance_days") and cond.tolerance_days is not None:
                cond_dict["tolerance_days"] = cond.tolerance_days
            if hasattr(cond, "similarity") and cond.similarity is not None:
                cond_dict["similarity"] = cond.similarity
            if hasattr(cond, "overlap_ratio") and cond.overlap_ratio is not None:
                cond_dict["overlap_ratio"] = cond.overlap_ratio
            conditions.append(cond_dict)

        update_data = {
            "description": rule.description or "",
            "severity": severity,
            "conditions": conditions,
            "updated_at": datetime.now(timezone.utc),
            "updated_by": "system",
        }

        if self.dry_run:
            print(f"      [DRY RUN] Would update: {rule_id}")
        else:
            self.db.collection(collection_path).document(rule_id).update(update_data)
            print(f"      🔄 Updated: {rule_id}")

        self.stats["duplicates"]["updated"] += 1

    # ========================================================================
    # RELATIONSHIP RULES MIGRATION
    # ========================================================================

    def _migrate_relationships(self) -> None:
        """Migrate relationship rules from YAML to Firestore."""
        print("\n🔗 Migrating Relationship Rules...")

        if not self.schema_config.entities:
            print("   No entities found in YAML")
            return

        for entity_name, entity_def in self.schema_config.entities.items():
            if not entity_def.relationships:
                continue

            print(f"\n   Entity: {entity_name}")

            for rel_name, rel_rule in entity_def.relationships.items():
                rule_id = f"{entity_name}_{rel_name}"
                self._create_relationship_rule(entity_name, rel_name, rule_id, rel_rule)

    def _create_relationship_rule(
        self, source_entity: str, target_entity: str, rule_id: str, rule: Any
    ) -> None:
        """Create a single relationship rule in Firestore."""
        collection_path = f"rules/relationships/{source_entity}"

        doc_data = {
            "rule_id": rule_id,
            "source_entity": source_entity,
            "target_entity": target_entity,
            "target": rule.target,
            "message": rule.message or "",
            "source": "yaml",
            "enabled": True,
            "created_at": datetime.now(timezone.utc),
            "updated_at": datetime.now(timezone.utc),
            "created_by": "system",
            "updated_by": "system",
        }

        # Optional fields
        if rule.min_links is not None:
            doc_data["min_links"] = rule.min_links
        if rule.max_links is not None:
            doc_data["max_links"] = rule.max_links
        if rule.require_active is not None:
            doc_data["require_active"] = rule.require_active
        if rule.condition_field:
            doc_data["condition_field"] = rule.condition_field
        if rule.condition_value is not None:
            doc_data["condition_value"] = rule.condition_value
        if rule.validate_bidirectional is not None:
            doc_data["validate_bidirectional"] = rule.validate_bidirectional

        if self.dry_run:
            print(f"      [DRY RUN] Would create: {rule_id}")
        else:
            self.db.collection(collection_path).document(rule_id).set(doc_data)
            print(f"      ✅ Created: {rule_id}")

        self.stats["relationships"]["created"] += 1

    def _sync_relationships(self) -> None:
        """Sync relationship rules from YAML (preserve user rules)."""
        print("\n🔗 Syncing Relationship Rules...")

        if not self.schema_config.entities:
            print("   No entities found in YAML")
            return

        for entity_name, entity_def in self.schema_config.entities.items():
            if not entity_def.relationships:
                continue

            print(f"\n   Entity: {entity_name}")

            # Get existing rules
            collection_path = f"rules/relationships/{entity_name}"
            existing_docs = self.db.collection(collection_path).stream()
            existing_rules = {doc.id: doc.to_dict() for doc in existing_docs}

            # Track YAML rule IDs
            yaml_rule_ids = set()

            for rel_name, rel_rule in entity_def.relationships.items():
                rule_id = f"{entity_name}_{rel_name}"
                yaml_rule_ids.add(rule_id)

                if rule_id in existing_rules:
                    existing = existing_rules[rule_id]
                    if existing.get("source") == "yaml":
                        self._update_relationship_rule(entity_name, rel_name, rule_id, rel_rule)
                    else:
                        print(f"      ⏭️  Preserved user rule: {rule_id}")
                        self.stats["relationships"]["preserved"] += 1
                else:
                    self._create_relationship_rule(entity_name, rel_name, rule_id, rel_rule)

            # Delete YAML rules that no longer exist
            for rule_id, rule_data in existing_rules.items():
                if rule_data.get("source") == "yaml" and rule_id not in yaml_rule_ids:
                    self._delete_rule(collection_path, rule_id, "relationships")

    def _update_relationship_rule(
        self, source_entity: str, target_entity: str, rule_id: str, rule: Any
    ) -> None:
        """Update an existing relationship rule."""
        collection_path = f"rules/relationships/{source_entity}"

        update_data = {
            "target": rule.target,
            "message": rule.message or "",
            "updated_at": datetime.now(timezone.utc),
            "updated_by": "system",
        }

        # Optional fields
        if rule.min_links is not None:
            update_data["min_links"] = rule.min_links
        if rule.max_links is not None:
            update_data["max_links"] = rule.max_links
        if rule.require_active is not None:
            update_data["require_active"] = rule.require_active
        if rule.condition_field:
            update_data["condition_field"] = rule.condition_field
        if rule.condition_value is not None:
            update_data["condition_value"] = rule.condition_value
        if rule.validate_bidirectional is not None:
            update_data["validate_bidirectional"] = rule.validate_bidirectional

        if self.dry_run:
            print(f"      [DRY RUN] Would update: {rule_id}")
        else:
            self.db.collection(collection_path).document(rule_id).update(update_data)
            print(f"      🔄 Updated: {rule_id}")

        self.stats["relationships"]["updated"] += 1

    # ========================================================================
    # REQUIRED FIELDS MIGRATION
    # ========================================================================

    def _cleanup_old_format_rules(self) -> None:
        """Delete required field rules that don't match the new format pattern.
        
        New format: required_field.{entity}.{field}
        Old formats: {entity}_{field}, required.{entity}.{field}, etc.
        """
        print("\n🧹 Cleaning up old format required field rules...")
        
        # Use dynamic entity list from schema instead of hardcoded
        entities = list(self.schema_config.entities.keys()) if self.schema_config.entities else []
        deleted_count = 0
        
        for entity in entities:
            collection_path = f"rules/required_fields/{entity}"
            try:
                docs = self.db.collection(collection_path).stream()
                for doc in docs:
                    rule_id = doc.id
                    rule_data = doc.to_dict()
                    
                    # Skip if not a YAML rule (preserve user rules)
                    if rule_data.get("source") != "yaml":
                        continue
                    
                    # Check if rule_id matches new format: required_field.{entity}.{field}
                    if not rule_id.startswith(f"required_field.{entity}."):
                        # This is an old format rule, delete it
                        if self.dry_run:
                            print(f"      [DRY RUN] Would delete old format rule: {entity}/{rule_id}")
                        else:
                            self.db.collection(collection_path).document(rule_id).delete()
                            print(f"      🗑️  Deleted old format rule: {entity}/{rule_id}")
                        deleted_count += 1
                        self.stats["required_fields"]["deleted"] += 1
            except Exception as exc:
                print(f"      ⚠️  Error cleaning up {entity}: {exc}")
        
        if deleted_count == 0:
            print("      ✅ No old format rules found")
        else:
            print(f"      ✅ Cleaned up {deleted_count} old format rule(s)")

    def _cleanup_removed_rules(self) -> None:
        """Delete YAML-sourced rules that are no longer in the YAML file.
        
        This ensures that when rules are removed from schema.yaml, they are also
        deleted from Firestore during sync operations.
        """
        print("\n🧹 Cleaning up rules removed from YAML...")
        
        if not self.schema_config.entities:
            print("      ⚠️  No entities in schema, skipping cleanup")
            return
        
        deleted_count = 0
        
        # Build expected rule IDs from YAML
        expected_required_field_rules = set()
        expected_duplicate_rules = set()
        
        # Collect expected required field rule IDs
        for entity_name, entity_def in self.schema_config.entities.items():
            if entity_def.missing_key_data:
                for field_req in entity_def.missing_key_data:
                    if hasattr(field_req, 'rule_id') and field_req.rule_id:
                        expected_required_field_rules.add((entity_name, field_req.rule_id))
                    else:
                        # Generate expected rule_id
                        field_name = field_req.field.replace("/", "_").replace(" ", "_").lower()
                        rule_id = f"required_field.{entity_name}.{field_name}"
                        expected_required_field_rules.add((entity_name, rule_id))
        
        # Collect expected duplicate rule IDs
        if self.schema_config.duplicates:
            for entity_name, dup_def in self.schema_config.duplicates.items():
                for rule in dup_def.likely:
                    if rule.rule_id:
                        expected_duplicate_rules.add((entity_name, "likely", rule.rule_id))
                for rule in dup_def.possible:
                    if rule.rule_id:
                        expected_duplicate_rules.add((entity_name, "possible", rule.rule_id))
        
        # Clean up required field rules
        for entity_name in self.schema_config.entities.keys():
            collection_path = f"rules/required_fields/{entity_name}"
            try:
                docs = self.db.collection(collection_path).stream()
                for doc in docs:
                    rule_id = doc.id
                    rule_data = doc.to_dict()
                    
                    # Skip if not a YAML rule (preserve user rules)
                    if rule_data.get("source") != "yaml":
                        continue
                    
                    # Check if this rule is expected
                    if (entity_name, rule_id) not in expected_required_field_rules:
                        # This rule was removed from YAML, delete it
                        if self.dry_run:
                            print(f"      [DRY RUN] Would delete removed rule: {entity_name}/{rule_id}")
                        else:
                            self.db.collection(collection_path).document(rule_id).delete()
                            print(f"      🗑️  Deleted removed rule: {entity_name}/{rule_id}")
                        deleted_count += 1
                        self.stats["required_fields"]["deleted"] += 1
            except Exception as exc:
                print(f"      ⚠️  Error cleaning up required fields for {entity_name}: {exc}")
        
        # Clean up duplicate rules
        if self.schema_config.duplicates:
            for entity_name in self.schema_config.duplicates.keys():
                collection_path = f"rules/duplicates/{entity_name}"
                try:
                    # Check likely duplicates
                    likely_path = f"{collection_path}/likely"
                    likely_docs = self.db.collection(likely_path).stream()
                    for doc in likely_docs:
                        rule_id = doc.id
                        rule_data = doc.to_dict()
                        
                        if rule_data.get("source") != "yaml":
                            continue
                        
                        if (entity_name, "likely", rule_id) not in expected_duplicate_rules:
                            if self.dry_run:
                                print(f"      [DRY RUN] Would delete removed duplicate rule: {entity_name}/likely/{rule_id}")
                            else:
                                self.db.collection(likely_path).document(rule_id).delete()
                                print(f"      🗑️  Deleted removed duplicate rule: {entity_name}/likely/{rule_id}")
                            deleted_count += 1
                            self.stats["duplicates"]["deleted"] += 1
                    
                    # Check possible duplicates
                    possible_path = f"{collection_path}/possible"
                    possible_docs = self.db.collection(possible_path).stream()
                    for doc in possible_docs:
                        rule_id = doc.id
                        rule_data = doc.to_dict()
                        
                        if rule_data.get("source") != "yaml":
                            continue
                        
                        if (entity_name, "possible", rule_id) not in expected_duplicate_rules:
                            if self.dry_run:
                                print(f"      [DRY RUN] Would delete removed duplicate rule: {entity_name}/possible/{rule_id}")
                            else:
                                self.db.collection(possible_path).document(rule_id).delete()
                                print(f"      🗑️  Deleted removed duplicate rule: {entity_name}/possible/{rule_id}")
                            deleted_count += 1
                            self.stats["duplicates"]["deleted"] += 1
                except Exception as exc:
                    print(f"      ⚠️  Error cleaning up duplicates for {entity_name}: {exc}")
        
        if deleted_count == 0:
            print("      ✅ No removed rules found")
        else:
            print(f"      ✅ Cleaned up {deleted_count} removed rule(s)")

    def _migrate_required_fields(self) -> None:
        """Migrate required field rules from YAML to Firestore."""
        print("\n📝 Migrating Required Field Rules...")

        if not self.schema_config.entities:
            print("   No entities found in YAML")
            return

        for entity_name, entity_def in self.schema_config.entities.items():
            if not entity_def.missing_key_data:
                continue

            print(f"\n   Entity: {entity_name}")

            for field_req in entity_def.missing_key_data:
                # Use rule_id from YAML if provided, otherwise generate in new format
                if hasattr(field_req, 'rule_id') and field_req.rule_id:
                    rule_id = field_req.rule_id
                else:
                    # Generate in new format: required_field.{entity}.{field_snake_case}
                    field_name = field_req.field.replace("/", "_").replace(" ", "_").lower()
                    rule_id = f"required_field.{entity_name}.{field_name}"
                self._create_required_field_rule(entity_name, rule_id, field_req)

    def _create_required_field_rule(
        self, entity: str, rule_id: str, field_req: Any
    ) -> None:
        """Create a single required field rule in Firestore."""
        collection_path = f"rules/required_fields/{entity}"

        doc_data = {
            "rule_id": rule_id,
            "entity": entity,
            "field": field_req.field,
            "message": field_req.message or "",
            "severity": field_req.severity or "warning",
            "source": "yaml",
            "enabled": True,
            "created_at": datetime.now(timezone.utc),
            "updated_at": datetime.now(timezone.utc),
            "created_by": "system",
            "updated_by": "system",
        }

        # Optional fields
        if field_req.alternate_fields:
            doc_data["alternate_fields"] = field_req.alternate_fields
        if field_req.condition_field:
            doc_data["condition_field"] = field_req.condition_field
        if field_req.condition_value is not None:
            doc_data["condition_value"] = field_req.condition_value

        if self.dry_run:
            print(f"      [DRY RUN] Would create: {rule_id}")
        else:
            self.db.collection(collection_path).document(rule_id).set(doc_data)
            print(f"      ✅ Created: {rule_id}")

        self.stats["required_fields"]["created"] += 1

    def _sync_required_fields(self) -> None:
        """Sync required field rules from YAML (preserve user rules)."""
        print("\n📝 Syncing Required Field Rules...")

        if not self.schema_config.entities:
            print("   No entities found in YAML")
            return

        for entity_name, entity_def in self.schema_config.entities.items():
            if not entity_def.missing_key_data:
                continue

            print(f"\n   Entity: {entity_name}")

            # Get existing rules
            collection_path = f"rules/required_fields/{entity_name}"
            existing_docs = self.db.collection(collection_path).stream()
            existing_rules = {doc.id: doc.to_dict() for doc in existing_docs}

            # Track YAML rule IDs
            yaml_rule_ids = set()

            for field_req in entity_def.missing_key_data:
                # Use rule_id from YAML if provided, otherwise generate in new format
                if hasattr(field_req, 'rule_id') and field_req.rule_id:
                    rule_id = field_req.rule_id
                else:
                    # Generate in new format: required_field.{entity}.{field_snake_case}
                    field_name = field_req.field.replace("/", "_").replace(" ", "_").lower()
                    rule_id = f"required_field.{entity_name}.{field_name}"
                yaml_rule_ids.add(rule_id)

                if rule_id in existing_rules:
                    existing = existing_rules[rule_id]
                    if existing.get("source") == "yaml":
                        self._update_required_field_rule(entity_name, rule_id, field_req)
                    else:
                        print(f"      ⏭️  Preserved user rule: {rule_id}")
                        self.stats["required_fields"]["preserved"] += 1
                else:
                    self._create_required_field_rule(entity_name, rule_id, field_req)

            # Delete YAML rules that no longer exist
            for rule_id, rule_data in existing_rules.items():
                if rule_data.get("source") == "yaml" and rule_id not in yaml_rule_ids:
                    self._delete_rule(collection_path, rule_id, "required_fields")

    def _update_required_field_rule(
        self, entity: str, rule_id: str, field_req: Any
    ) -> None:
        """Update an existing required field rule."""
        collection_path = f"rules/required_fields/{entity}"

        update_data = {
            "rule_id": rule_id,
            "field": field_req.field,
            "message": field_req.message or "",
            "severity": field_req.severity or "warning",
            "updated_at": datetime.now(timezone.utc),
            "updated_by": "system",
        }

        # Optional fields
        if field_req.alternate_fields:
            update_data["alternate_fields"] = field_req.alternate_fields
        if field_req.condition_field:
            update_data["condition_field"] = field_req.condition_field
        if field_req.condition_value is not None:
            update_data["condition_value"] = field_req.condition_value

        if self.dry_run:
            print(f"      [DRY RUN] Would update: {rule_id}")
        else:
            self.db.collection(collection_path).document(rule_id).update(update_data)
            print(f"      🔄 Updated: {rule_id}")

        self.stats["required_fields"]["updated"] += 1

    # ========================================================================
    # ATTENDANCE RULES MIGRATION
    # ========================================================================

    def _migrate_attendance(self) -> None:
        """Migrate attendance rules from YAML to Firestore."""
        print("\n📅 Migrating Attendance Rules...")

        if not self.runtime_config.attendance_rules:
            print("   No attendance rules found in YAML")
            return

        # Migrate config settings
        self._create_attendance_config()

        # Migrate thresholds
        for metric_name, thresholds in self.runtime_config.attendance_rules.thresholds.items():
            rule_id = metric_name
            self._create_attendance_threshold(rule_id, metric_name, thresholds)

    def _create_attendance_config(self) -> None:
        """Create attendance config settings in Firestore."""
        doc_data = {
            "onboarding_grace_days": self.runtime_config.attendance_rules.onboarding_grace_days,
            "limited_schedule_threshold": self.runtime_config.attendance_rules.limited_schedule_threshold,
            "updated_at": datetime.now(timezone.utc),
            "updated_by": "system",
            "source": "yaml",
        }

        if self.dry_run:
            print("   [DRY RUN] Would create attendance config")
        else:
            self.db.collection("rules/attendance/config").document("settings").set(doc_data)
            print("   ✅ Created attendance config")

    def _create_attendance_threshold(
        self, rule_id: str, metric: str, thresholds: Any
    ) -> None:
        """Create a single attendance threshold rule in Firestore."""
        collection_path = "rules/attendance/thresholds"

        doc_data = {
            "rule_id": rule_id,
            "metric": metric,
            "source": "yaml",
            "enabled": True,
            "created_at": datetime.now(timezone.utc),
            "updated_at": datetime.now(timezone.utc),
            "created_by": "system",
            "updated_by": "system",
        }

        # Add threshold values
        if thresholds.info is not None:
            doc_data["info"] = thresholds.info
        if thresholds.warning is not None:
            doc_data["warning"] = thresholds.warning
        if thresholds.critical is not None:
            doc_data["critical"] = thresholds.critical

        if self.dry_run:
            print(f"   [DRY RUN] Would create threshold: {rule_id}")
        else:
            self.db.collection(collection_path).document(rule_id).set(doc_data)
            print(f"   ✅ Created threshold: {rule_id}")

        self.stats["attendance"]["created"] += 1

    def _sync_attendance(self) -> None:
        """Sync attendance rules from YAML (preserve user rules)."""
        print("\n📅 Syncing Attendance Rules...")

        if not self.runtime_config.attendance_rules:
            print("   No attendance rules found in YAML")
            return

        # Update config settings
        if self.dry_run:
            print("   [DRY RUN] Would update attendance config")
        else:
            doc_data = {
                "onboarding_grace_days": self.runtime_config.attendance_rules.onboarding_grace_days,
                "limited_schedule_threshold": self.runtime_config.attendance_rules.limited_schedule_threshold,
                "updated_at": datetime.now(timezone.utc),
                "updated_by": "system",
            }
            self.db.collection("rules/attendance/config").document("settings").update(doc_data)
            print("   🔄 Updated attendance config")

        # Get existing thresholds
        collection_path = "rules/attendance/thresholds"
        existing_docs = self.db.collection(collection_path).stream()
        existing_rules = {doc.id: doc.to_dict() for doc in existing_docs}

        # Track YAML rule IDs
        yaml_rule_ids = set()

        # Sync thresholds
        for metric_name, thresholds in self.runtime_config.attendance_rules.thresholds.items():
            rule_id = metric_name
            yaml_rule_ids.add(rule_id)

            if rule_id in existing_rules:
                existing = existing_rules[rule_id]
                if existing.get("source") == "yaml":
                    self._update_attendance_threshold(rule_id, metric_name, thresholds)
                else:
                    print(f"   ⏭️  Preserved user threshold: {rule_id}")
                    self.stats["attendance"]["preserved"] += 1
            else:
                self._create_attendance_threshold(rule_id, metric_name, thresholds)

        # Delete YAML rules that no longer exist
        for rule_id, rule_data in existing_rules.items():
            if rule_data.get("source") == "yaml" and rule_id not in yaml_rule_ids:
                self._delete_rule(collection_path, rule_id, "attendance")

    def _update_attendance_threshold(
        self, rule_id: str, metric: str, thresholds: Any
    ) -> None:
        """Update an existing attendance threshold."""
        collection_path = "rules/attendance/thresholds"

        update_data = {
            "metric": metric,
            "updated_at": datetime.now(timezone.utc),
            "updated_by": "system",
        }

        if thresholds.info is not None:
            update_data["info"] = thresholds.info
        if thresholds.warning is not None:
            update_data["warning"] = thresholds.warning
        if thresholds.critical is not None:
            update_data["critical"] = thresholds.critical

        if self.dry_run:
            print(f"   [DRY RUN] Would update threshold: {rule_id}")
        else:
            self.db.collection(collection_path).document(rule_id).update(update_data)
            print(f"   🔄 Updated threshold: {rule_id}")

        self.stats["attendance"]["updated"] += 1

    # ========================================================================
    # UTILITY METHODS
    # ========================================================================

    def _delete_all_rules(self) -> None:
        """Delete all rules from Firestore."""
        print("\n🗑️  Deleting all Firestore rules...")

        categories = [
            ("duplicates", ["students", "parents", "contractors"]),
            ("relationships", ["students", "parents", "contractors", "classes"]),
            ("required_fields", ["students", "parents", "contractors", "classes"]),
            ("attendance/thresholds", [None]),
        ]

        for category, entities in categories:
            if entities == [None]:
                # Direct collection (attendance thresholds)
                collection_path = f"rules/{category}"
                self._delete_collection(collection_path, category.split("/")[0])
            else:
                # Entity-based collections
                for entity in entities:
                    collection_path = f"rules/{category}/{entity}"
                    self._delete_collection(collection_path, category)

    def _delete_collection(self, collection_path: str, category: str) -> None:
        """Delete all documents in a collection."""
        docs = self.db.collection(collection_path).stream()

        deleted = 0
        for doc in docs:
            if self.dry_run:
                print(f"   [DRY RUN] Would delete: {doc.id}")
            else:
                doc.reference.delete()
            deleted += 1

        if deleted > 0:
            self.stats[category]["deleted"] += deleted
            if not self.dry_run:
                print(f"   🗑️  Deleted {deleted} rule(s) from {collection_path}")

    def _delete_rule(self, collection_path: str, rule_id: str, category: str) -> None:
        """Delete a single rule."""
        if self.dry_run:
            print(f"      [DRY RUN] Would delete: {rule_id}")
        else:
            self.db.collection(collection_path).document(rule_id).delete()
            print(f"      🗑️  Deleted: {rule_id}")

        self.stats[category]["deleted"] += 1

    def _print_summary(self) -> None:
        """Print migration summary."""
        print("\n" + "=" * 70)
        print("MIGRATION SUMMARY")
        print("=" * 70)

        total_created = sum(cat["created"] for cat in self.stats.values())
        total_updated = sum(cat["updated"] for cat in self.stats.values())
        total_deleted = sum(cat["deleted"] for cat in self.stats.values())
        total_preserved = sum(cat["preserved"] for cat in self.stats.values())

        for category, stats in self.stats.items():
            if any(stats.values()):
                print(f"\n{category.upper()}:")
                if stats["created"]:
                    print(f"   Created:   {stats['created']}")
                if stats["updated"]:
                    print(f"   Updated:   {stats['updated']}")
                if stats["deleted"]:
                    print(f"   Deleted:   {stats['deleted']}")
                if stats["preserved"]:
                    print(f"   Preserved: {stats['preserved']}")

        print("\n" + "-" * 70)
        print(f"TOTAL:")
        print(f"   Created:   {total_created}")
        print(f"   Updated:   {total_updated}")
        print(f"   Deleted:   {total_deleted}")
        print(f"   Preserved: {total_preserved}")
        print("=" * 70)

        if self.dry_run:
            print("\n🔍 DRY RUN - No changes were made")
        else:
            print("\n✅ Migration completed successfully")


def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="Migrate rules from YAML to Firestore",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Initial migration (dry run first)
  python -m backend.scripts.migrate_rules --action=migrate --dry-run
  python -m backend.scripts.migrate_rules --action=migrate

  # Sync YAML changes (preserve user rules)
  python -m backend.scripts.migrate_rules --action=sync

  # Reset to YAML defaults
  python -m backend.scripts.migrate_rules --action=reset --confirm

  # Clear all rules
  python -m backend.scripts.migrate_rules --action=clear --confirm
        """,
    )

    parser.add_argument(
        "--action",
        choices=["migrate", "sync", "reset", "clear"],
        required=True,
        help="Action to perform",
    )

    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Preview changes without making them",
    )

    parser.add_argument(
        "--confirm",
        action="store_true",
        help="Confirm destructive actions (required for reset/clear)",
    )

    args = parser.parse_args()

    # Require confirmation for destructive actions
    if args.action in ("reset", "clear") and not args.confirm and not args.dry_run:
        print("\n❌ ERROR: Destructive action requires --confirm flag")
        print(f"   Use: --action={args.action} --confirm")
        print("   Or preview with: --dry-run")
        sys.exit(1)

    try:
        migrator = RulesMigrator(dry_run=args.dry_run)

        if args.action == "migrate":
            migrator.migrate()
        elif args.action == "sync":
            migrator.sync()
        elif args.action == "reset":
            migrator.reset()
        elif args.action == "clear":
            migrator.clear()

    except KeyboardInterrupt:
        print("\n\n⚠️  Migration interrupted by user")
        sys.exit(1)
    except Exception as e:
        print(f"\n\n❌ ERROR: {str(e)}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
