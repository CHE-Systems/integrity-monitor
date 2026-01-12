#!/usr/bin/env python3
"""
Script to exhaustively list ALL rules in Firestore by directly querying the database.
This will help us find rules that might be stored under unexpected paths.
"""

import sys
from pathlib import Path

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from google.cloud import firestore

try:
    db = firestore.Client()
except Exception as exc:
    print(f"❌ Failed to initialize Firestore client: {exc}")
    sys.exit(1)

print("=" * 80)
print("Exhaustive Firestore Rules Search")
print("=" * 80)
print("\nSearching for ALL documents under 'rules/' collection...")
print()

# Try to list all documents in the rules collection by getting the "rules" document
# and then listing its subcollections
try:
    # Firestore structure: rules/{category}/{entity}/{rule_id}
    # We need to check all possible paths

    categories = ["duplicates", "relationships", "required_fields", "attendance"]

    # All possible entity names (including variations)
    entity_variants = [
        "students", "student", "Students",
        "contractors", "contractor", "Contractors", "Contractors/Volunteers",
        "parents", "parent", "Parents",
        "absent", "Absent",
        "apps", "Apps",
        "tables", "Tables",
        "truth", "Truth",
        "student_truth", "Student Truth",
        "classes", "Classes",
        "attendance", "Attendance",
        "payments", "Payments",
    ]

    all_found_rules = []

    for category in categories:
        print(f"\n📁 Category: {category}")
        print("-" * 80)

        found_in_category = False

        for entity in entity_variants:
            collection_path = f"rules/{category}/{entity}"
            try:
                docs = list(db.collection(collection_path).stream())

                if docs:
                    found_in_category = True
                    print(f"\n  ✅ Found {len(docs)} rule(s) in: {collection_path}")

                    for doc in docs:
                        doc_data = doc.to_dict()
                        enabled = doc_data.get("enabled", True)
                        enabled_icon = "✓" if enabled else "✗"

                        # Show key info
                        rule_id = doc_data.get("rule_id", doc.id)
                        description = doc_data.get("description", "No description")
                        if len(description) > 60:
                            description = description[:57] + "..."

                        print(f"     {enabled_icon} {doc.id}")
                        print(f"        rule_id: {rule_id}")
                        print(f"        description: {description}")
                        print(f"        enabled: {enabled}")

                        # Store for summary
                        all_found_rules.append({
                            "category": category,
                            "entity": entity,
                            "doc_id": doc.id,
                            "rule_id": rule_id,
                            "enabled": enabled,
                            "data": doc_data
                        })
            except Exception as exc:
                # Silently skip non-existent collections
                pass

        if not found_in_category:
            print(f"  ⚪ No rules found in any entity for {category}")

    # Print summary
    print("\n" + "=" * 80)
    print("Summary")
    print("=" * 80)

    if all_found_rules:
        print(f"\n✅ Found {len(all_found_rules)} total rule(s)")

        # Group by category and entity
        by_category = {}
        for rule in all_found_rules:
            cat = rule["category"]
            ent = rule["entity"]
            if cat not in by_category:
                by_category[cat] = {}
            if ent not in by_category[cat]:
                by_category[cat][ent] = []
            by_category[cat][ent].append(rule)

        print("\nRules by category and entity:")
        for cat, entities in sorted(by_category.items()):
            print(f"\n  {cat}:")
            for ent, rules in sorted(entities.items()):
                enabled_count = sum(1 for r in rules if r["enabled"])
                disabled_count = len(rules) - enabled_count
                status = f" ({disabled_count} disabled)" if disabled_count > 0 else ""
                print(f"    {ent}: {len(rules)} rule(s){status}")

        # Show disabled rules
        disabled_rules = [r for r in all_found_rules if not r["enabled"]]
        if disabled_rules:
            print(f"\n⚠️  WARNING: {len(disabled_rules)} disabled rule(s):")
            for rule in disabled_rules:
                print(f"  - {rule['category']}/{rule['entity']}/{rule['doc_id']}")
    else:
        print("\n⚠️  No rules found in Firestore!")
        print("   This means:")
        print("   1. Rules haven't been created yet, OR")
        print("   2. Rules are stored in a different location, OR")
        print("   3. There's a permissions issue")

    print("\n" + "=" * 80)

except Exception as exc:
    print(f"❌ Error during search: {exc}")
    import traceback
    traceback.print_exc()
