#!/usr/bin/env python3
"""
Diagnostic script to list all rules collections and entity names in Firestore.

This helps identify:
- What entity names are actually used in Firestore
- What collections exist
- Why rules might not be loading
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
print("Firestore Rules Diagnostic")
print("=" * 80)

# Rule categories to check
categories = ["duplicates", "relationships", "required_fields"]

# Track what we find
found_entities = defaultdict(set)
all_collections = []

for category in categories:
    print(f"\n📁 Category: {category}")
    print("-" * 80)

    # Try all possible entity names
    test_entities = [
        "contractors", "contractor", "Contractors/Volunteers",
        "students", "student",
        "parents", "parent",
        "absent", "apps", "tables"
    ]

    for entity in test_entities:
        collection_path = f"rules/{category}/{entity}"
        try:
            # Try to get one document to see if collection exists
            docs = db.collection(collection_path).limit(1).stream()
            doc_list = list(docs)

            if doc_list:
                # Collection exists and has documents
                # Count all documents and check enabled status
                all_docs = list(db.collection(collection_path).stream())
                count = len(all_docs)

                # Check enabled status
                enabled_count = sum(1 for doc in all_docs if doc.to_dict().get("enabled", True))
                disabled_count = count - enabled_count

                print(f"  ✅ {collection_path}: {count} document(s)")
                if disabled_count > 0:
                    print(f"     ⚠️  {disabled_count} disabled, {enabled_count} enabled")
                else:
                    print(f"     ✓ All {enabled_count} rules enabled")

                found_entities[category].add(entity)
                all_collections.append((category, entity, count, enabled_count, disabled_count))

                # Show sample document IDs and enabled status
                sample_docs = db.collection(collection_path).limit(3).stream()
                for doc in sample_docs:
                    doc_data = doc.to_dict()
                    enabled_status = "✓" if doc_data.get("enabled", True) else "✗"
                    print(f"     {enabled_status} {doc.id}")
        except Exception as exc:
            # Collection doesn't exist or error accessing it
            pass

print("\n" + "=" * 80)
print("Summary")
print("=" * 80)

if found_entities:
    print("\n✅ Found rules in these collections:")
    total_disabled = 0
    for category, entities in found_entities.items():
        print(f"  {category}:")
        for entity in sorted(entities):
            data = next((d for d in all_collections if d[0] == category and d[1] == entity), None)
            if data:
                _, _, count, enabled, disabled = data
                total_disabled += disabled
                status = f" ({disabled} disabled)" if disabled > 0 else ""
                print(f"    - {entity}: {count} rules{status}")

    if total_disabled > 0:
        print(f"\n⚠️  WARNING: Found {total_disabled} disabled rule(s) across all collections!")
        print("   Disabled rules will NOT be loaded by the backend.")
else:
    print("\n⚠️  No rules found in any collections!")
    print("   This could mean:")
    print("   1. Rules are stored in a different location")
    print("   2. Firestore permissions are blocking access")
    print("   3. Rules haven't been created yet")

print("\n" + "=" * 80)
print("Next Steps")
print("=" * 80)
print("1. Check the Rules Management page to see what entity names it uses")
print("2. Verify the rules are actually in Firestore (check Firebase Console)")
print("3. Check if rules are stored under different paths")
print("4. Verify Firestore permissions allow reading from rules/ collections")

