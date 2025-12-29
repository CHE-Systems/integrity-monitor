#!/usr/bin/env python3
"""List all rules currently in Firestore with details."""

import sys
import os
from google.cloud import firestore

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

def list_firestore_rules():
    """List all rules in Firestore with full details."""
    db = firestore.Client()

    print("=" * 80)
    print("FIRESTORE RULES INVENTORY")
    print("=" * 80)

    categories = ["duplicates", "relationships", "required_fields"]

    for category in categories:
        print(f"\n### {category.upper()} ###")

        # Check contractors
        collection_path = f"rules/{category}/contractors"
        docs = list(db.collection(collection_path).stream())

        if docs:
            print(f"\nContractors ({len(docs)} rules):")
            for doc in docs:
                data = doc.to_dict()
                print(f"  - ID: {doc.id}")
                print(f"    rule_id: {data.get('rule_id', 'N/A')}")
                print(f"    enabled: {data.get('enabled', 'N/A')}")
                if category == "duplicates":
                    print(f"    description: {data.get('description', 'N/A')}")
                elif category == "required_fields":
                    print(f"    field: {data.get('field', 'N/A')}")
                    print(f"    message: {data.get('message', 'N/A')}")
                print()
        else:
            print(f"\nContractors: No rules found")

    # Check attendance
    print(f"\n### ATTENDANCE ###")
    attendance_ref = db.collection("rules").document("attendance_thresholds")
    attendance_doc = attendance_ref.get()
    if attendance_doc.exists:
        data = attendance_doc.to_dict()
        thresholds = data.get("thresholds", {})
        print(f"Thresholds: {len(thresholds)}")
        for entity, threshold in thresholds.items():
            print(f"  - {entity}: {threshold}")
    else:
        print("No attendance config found")

    print("\n" + "=" * 80)

if __name__ == "__main__":
    list_firestore_rules()
