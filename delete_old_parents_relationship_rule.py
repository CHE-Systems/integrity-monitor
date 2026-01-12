#!/usr/bin/env python3
"""
Delete the old parents→students relationship rule and replace it with a required field rule.

This script:
1. Deletes the relationship rule at: rules/relationships/parents/link.parents.students
2. The new required field rule should be created via the frontend app

Usage:
    python3 delete_old_parents_relationship_rule.py
"""

from google.cloud import firestore

def main():
    # Initialize Firestore
    print("Initializing Firestore client...")
    db = firestore.Client(project='data-integrity-monitor')

    # Path to the old relationship rule
    rule_path = 'rules/relationships/parents/link.parents.students'
    print(f"\n=== Deleting Old Relationship Rule ===")
    print(f"Rule path: {rule_path}")

    # Get the document reference
    doc_ref = db.collection('rules').document('relationships').collection('parents').document('link.parents.students')

    # Check if it exists first
    doc = doc_ref.get()
    if doc.exists:
        print(f"\nFound rule:")
        data = doc.to_dict()
        print(f"  Rule ID: {data.get('rule_id')}")
        print(f"  Message: {data.get('message')}")
        print(f"  Min links: {data.get('min_links')}")
        print(f"  Enabled: {data.get('enabled')}")

        # Delete it
        print(f"\nDeleting rule...")
        doc_ref.delete()
        print("✓ Rule deleted successfully!")

        # Verify deletion
        if not doc_ref.get().exists:
            print("✓ Verified: Rule no longer exists in Firestore")
        else:
            print("✗ Warning: Rule still exists after deletion attempt")
    else:
        print(f"\n✗ Rule not found at path: {rule_path}")
        print("It may have already been deleted.")

    print("\n=== Next Steps ===")
    print("1. Create the new required field rule using the frontend app:")
    print("   - Entity: parents")
    print("   - Field ID: fldvkauZW6jkGpAUO")
    print("   - Field Name: Student")
    print("   - Severity: warning")
    print("   - Message: 'Every parent should have at least one student linked'")
    print("\n2. Run a test scan to verify the new rule works correctly")

if __name__ == "__main__":
    main()
