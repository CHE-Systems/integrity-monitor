#!/usr/bin/env python3
"""
Convert relationship rules to simple required field rules.

Relationship rules are overly complex and error-prone. For this use case,
we just want to check if a link field has a value (is not empty).

This script:
1. Reads all relationship rules from Firestore
2. Converts them to required field rules
3. Deletes the original relationship rules
"""

import sys
from pathlib import Path
from datetime import datetime, timezone

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from google.cloud import firestore

try:
    db = firestore.Client()
except Exception as exc:
    print(f"❌ Failed to initialize Firestore client: {exc}")
    sys.exit(1)

print("=" * 80)
print("Convert Relationship Rules to Required Field Rules")
print("=" * 80)
print()

# Entity variants to check
entities = ["students", "parents", "contractors", "absent"]

converted_count = 0
deleted_count = 0

for entity in entities:
    collection_path = f"rules/relationships/{entity}"

    try:
        docs = list(db.collection(collection_path).stream())

        if not docs:
            continue

        print(f"\n📁 Entity: {entity}")
        print(f"   Found {len(docs)} relationship rule(s)")

        for doc in docs:
            rule_data = doc.to_dict()
            rule_id = doc.id
            target = rule_data.get("target")
            description = rule_data.get("description", "")
            message = rule_data.get("message", "")

            if not target:
                print(f"   ⚠️  Skipping {rule_id} - no target specified")
                continue

            # Determine the field name (usually just the relationship key)
            # For "link.parents.students", the field is "students"
            field_name = rule_id.split(".")[-1] if "." in rule_id else target

            print(f"\n   Converting: {rule_id}")
            print(f"      Target: {target}")
            print(f"      Field: {field_name}")

            # Create required field rule
            required_field_rule_id = f"required_field_rule.{entity}.{field_name}"
            required_field_collection = f"rules/required_fields/{entity}"

            # Check if required field rule already exists
            req_doc_ref = db.collection(required_field_collection).document(required_field_rule_id)
            if req_doc_ref.get().exists:
                print(f"      ⚪ Required field rule already exists: {required_field_rule_id}")
            else:
                # Create the required field rule
                required_field_data = {
                    "rule_id": required_field_rule_id,
                    "entity": entity,
                    "field": field_name,  # Just use the field name
                    "field_name": field_name,
                    "severity": "warning",
                    "message": message or description or f"{entity.capitalize()} must have at least one {field_name} link.",
                    "description": message or description or f"Check that {field_name} field is populated.",
                    "enabled": True,
                    "source": "relationship_conversion",
                    "created_at": datetime.now(timezone.utc),
                    "updated_at": datetime.now(timezone.utc),
                    "created_by": "conversion_script",
                    "updated_by": "conversion_script",
                    "converted_from": rule_id,
                }

                req_doc_ref.set(required_field_data)
                print(f"      ✓ Created required field rule: {required_field_rule_id}")
                converted_count += 1

            # Delete the original relationship rule
            doc.reference.delete()
            print(f"      ✓ Deleted relationship rule: {rule_id}")
            deleted_count += 1

    except Exception as exc:
        print(f"   ❌ Error processing {entity}: {exc}")
        import traceback
        traceback.print_exc()

print("\n" + "=" * 80)
print("Summary")
print("=" * 80)
print(f"\n✅ Converted {converted_count} relationship rule(s) to required field rules")
print(f"✅ Deleted {deleted_count} relationship rule(s)")

print("\n" + "=" * 80)
print("Next Steps")
print("=" * 80)
print("1. Run diagnostic script to verify:")
print("   python -m scripts.diagnose_rules")
print("2. Restart backend")
print("3. Test scans - they should now work without errors")
