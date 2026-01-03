#!/usr/bin/env python3
"""
Migrate rules from schema.yaml to Firestore.

This script reads the legacy schema.yaml file and migrates:
1. Duplicate detection rules
2. Required field rules
3. Relationship rules

to the new Firestore-based rules/ collection structure.
"""

import sys
from pathlib import Path
import yaml
from datetime import datetime, timezone

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from google.cloud import firestore

try:
    db = firestore.Client()
except Exception as exc:
    print(f"❌ Failed to initialize Firestore client: {exc}")
    sys.exit(1)

# Load schema.yaml
schema_path = Path(__file__).parent.parent / "config" / "schema.yaml"
if not schema_path.exists():
    print(f"❌ schema.yaml not found at {schema_path}")
    sys.exit(1)

with open(schema_path, "r") as f:
    schema = yaml.safe_load(f)

print("=" * 80)
print("Migrate schema.yaml Rules to Firestore")
print("=" * 80)
print()

# Track migrations
migrated_count = 0
skipped_count = 0

# 1. Migrate duplicate rules
print("📁 Migrating duplicate detection rules...")
print("-" * 80)

duplicates = schema.get("duplicates", {})
for entity, dup_rules in duplicates.items():
    print(f"\n  Entity: {entity}")

    for severity in ["likely", "possible"]:
        rules_list = dup_rules.get(severity, [])
        for rule in rules_list:
            rule_id = rule.get("rule_id")
            description = rule.get("description", "")
            conditions = rule.get("conditions", [])

            if not rule_id:
                print(f"    ⚠️  Skipping rule without rule_id in {entity}/{severity}")
                skipped_count += 1
                continue

            # Check if rule already exists
            collection_path = f"rules/duplicates/{entity}"
            doc_ref = db.collection(collection_path).document(rule_id)
            if doc_ref.get().exists:
                print(f"    ⚪ Already exists: {rule_id}")
                skipped_count += 1
                continue

            # Create Firestore document
            rule_data = {
                "rule_id": rule_id,
                "entity": entity,
                "description": description,
                "severity": severity,
                "conditions": conditions,
                "enabled": True,
                "source": "schema_yaml_migration",
                "created_at": datetime.now(timezone.utc),
                "updated_at": datetime.now(timezone.utc),
                "created_by": "migration_script",
                "updated_by": "migration_script",
            }

            doc_ref.set(rule_data)
            print(f"    ✓ Migrated: {rule_id}")
            migrated_count += 1

# 2. Migrate required field rules
print("\n\n📁 Migrating required field rules...")
print("-" * 80)

entities = schema.get("entities", {})
for entity_name, entity_data in entities.items():
    missing_key_data = entity_data.get("missing_key_data", [])

    if not missing_key_data:
        continue

    print(f"\n  Entity: {entity_name}")

    for field_rule in missing_key_data:
        field = field_rule.get("field")
        rule_id = field_rule.get("rule_id")
        severity = field_rule.get("severity", "warning")
        message = field_rule.get("message", "")

        if not rule_id or not field:
            print(f"    ⚠️  Skipping rule without rule_id or field in {entity_name}")
            skipped_count += 1
            continue

        # Check if rule already exists
        collection_path = f"rules/required_fields/{entity_name}"
        doc_ref = db.collection(collection_path).document(rule_id)
        if doc_ref.get().exists:
            print(f"    ⚪ Already exists: {rule_id}")
            skipped_count += 1
            continue

        # Create Firestore document
        rule_data = {
            "rule_id": rule_id,
            "entity": entity_name,
            "field": field,  # This is a field ID (fld...)
            "field_id": field,  # Store explicitly as field_id
            "severity": severity,
            "message": message,
            "description": message,  # Use message as description
            "enabled": True,
            "source": "schema_yaml_migration",
            "created_at": datetime.now(timezone.utc),
            "updated_at": datetime.now(timezone.utc),
            "created_by": "migration_script",
            "updated_by": "migration_script",
        }

        doc_ref.set(rule_data)
        print(f"    ✓ Migrated: {rule_id}")
        migrated_count += 1

# 3. Migrate relationship rules
print("\n\n📁 Migrating relationship rules...")
print("-" * 80)

for entity_name, entity_data in entities.items():
    relationships = entity_data.get("relationships", {})

    if not relationships:
        continue

    print(f"\n  Entity: {entity_name}")

    for rel_name, rel_data in relationships.items():
        target = rel_data.get("target")
        min_links = rel_data.get("min_links")
        max_links = rel_data.get("max_links")
        require_active = rel_data.get("require_active", False)
        message = rel_data.get("message", "")
        condition_field = rel_data.get("condition_field")
        condition_value = rel_data.get("condition_value")

        # Generate rule_id
        rule_id = f"link.{entity_name}.{rel_name}"

        # Check if rule already exists
        collection_path = f"rules/relationships/{entity_name}"
        doc_ref = db.collection(collection_path).document(rule_id)
        if doc_ref.get().exists:
            print(f"    ⚪ Already exists: {rule_id}")
            skipped_count += 1
            continue

        # Create Firestore document
        rule_data = {
            "rule_id": rule_id,
            "source_entity": entity_name,
            "target": target,
            "description": message,
            "message": message,
            "enabled": True,
            "source": "schema_yaml_migration",
            "created_at": datetime.now(timezone.utc),
            "updated_at": datetime.now(timezone.utc),
            "created_by": "migration_script",
            "updated_by": "migration_script",
        }

        # Add optional fields
        if min_links is not None:
            rule_data["min_links"] = min_links
        if max_links is not None:
            rule_data["max_links"] = max_links
        if require_active:
            rule_data["require_active"] = require_active
        if condition_field:
            rule_data["condition_field"] = condition_field
        if condition_value:
            rule_data["condition_value"] = condition_value

        doc_ref.set(rule_data)
        print(f"    ✓ Migrated: {rule_id}")
        migrated_count += 1

# Print summary
print("\n" + "=" * 80)
print("Migration Summary")
print("=" * 80)
print(f"\n✅ Migrated {migrated_count} rule(s)")
print(f"⚪ Skipped {skipped_count} rule(s) (already exist)")
print(f"\n✓ Total processed: {migrated_count + skipped_count}")

print("\n" + "=" * 80)
print("Next Steps")
print("=" * 80)
print("1. Verify rules in Firebase Console")
print("2. Run diagnostic script to confirm all rules are enabled:")
print("   python -m scripts.diagnose_rules")
print("3. Restart backend and test scan configuration modal")
print("4. Test creating a scan with contractors/students rules")
