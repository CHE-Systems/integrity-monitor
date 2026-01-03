#!/usr/bin/env python3
"""
Script to enable all rules in Firestore.

This ensures every rule has enabled=True so they all load correctly.
"""

import sys
from pathlib import Path
from collections import defaultdict

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from google.cloud import firestore

try:
    db = firestore.Client()
except Exception as exc:
    print(f"❌ Failed to initialize Firestore client: {exc}")
    sys.exit(1)

print("=" * 80)
print("Enable All Rules Script")
print("=" * 80)
print("\nThis script will set enabled=True on all rules in Firestore.")
print("")

# Rule categories to check
categories = ["duplicates", "relationships", "required_fields"]

# Try all possible entity names
test_entities = [
    "contractors", "contractor", "Contractors/Volunteers",
    "students", "student",
    "parents", "parent",
    "absent", "apps", "tables"
]

# Track what we update
updates = []
total_updated = 0
total_already_enabled = 0

for category in categories:
    print(f"\n📁 Processing category: {category}")
    print("-" * 80)

    for entity in test_entities:
        collection_path = f"rules/{category}/{entity}"
        try:
            # Get all documents
            docs = list(db.collection(collection_path).stream())

            if docs:
                print(f"  Found {len(docs)} rule(s) in {entity}")

                for doc in docs:
                    doc_data = doc.to_dict()
                    current_enabled = doc_data.get("enabled", True)

                    if not current_enabled:
                        # Update to enabled=True
                        doc.reference.update({"enabled": True})
                        print(f"    ✓ Enabled: {doc.id}")
                        updates.append((category, entity, doc.id))
                        total_updated += 1
                    else:
                        total_already_enabled += 1

        except Exception as exc:
            # Collection doesn't exist or error accessing it
            pass

print("\n" + "=" * 80)
print("Summary")
print("=" * 80)

if total_updated > 0:
    print(f"\n✅ Updated {total_updated} rule(s) to enabled=True")
    print(f"✓ {total_already_enabled} rule(s) were already enabled")

    print("\nUpdated rules by category:")
    by_category = defaultdict(list)
    for category, entity, rule_id in updates:
        by_category[category].append((entity, rule_id))

    for category, items in by_category.items():
        print(f"\n  {category}:")
        for entity, rule_id in items:
            print(f"    - {entity}/{rule_id}")
else:
    print(f"\n✓ All {total_already_enabled} rules were already enabled!")
    print("  No updates needed.")

print("\n" + "=" * 80)
print("Next Steps")
print("=" * 80)
print("1. Run the diagnostic script to verify all rules are enabled:")
print("   python -m scripts.diagnose_rules")
print("2. Restart the backend to reload rules")
print("3. Test the scan configuration modal")
