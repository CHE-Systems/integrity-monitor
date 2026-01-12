#!/usr/bin/env python3
"""
Create a required field rule for parents entity to check that the Student field is populated.

This script creates a new rule at: rules/required_fields/parents/{rule_id}

Usage:
    python3 create_parents_student_required_rule.py
"""

from google.cloud import firestore
from datetime import datetime, timezone

def main():
    # Initialize Firestore
    print("Initializing Firestore client...")
    db = firestore.Client(project='data-integrity-monitor')

    # Define the rule data
    rule_id = "required_field_rule.parents.student_link"

    rule_data = {
        # Core rule identification
        "rule_id": rule_id,
        "entity": "parents",
        "category": "required_fields",

        # Field information
        "field": "fldvkauZW6jkGpAUO",  # Field ID for "Student" field
        "field_id": "fldvkauZW6jkGpAUO",
        "field_name": "Student",

        # Field lookup metadata (from schema)
        "field_lookup_status": "found",
        "field_lookup_message": "Found field 'Student' (ID: fldvkauZW6jkGpAUO)",

        # Rule configuration
        "severity": "warning",
        "message": "Every parent should have at least one student linked",
        "enabled": True,

        # Metadata
        "source": "user",
        "created_by": "system",
        "updated_by": "system",
        "created_at": datetime.now(timezone.utc),
        "updated_at": datetime.now(timezone.utc),
    }

    # Path to the new rule
    rule_path = f'rules/required_fields/parents/{rule_id}'
    print(f"\n=== Creating New Required Field Rule ===")
    print(f"Rule path: {rule_path}")
    print(f"\nRule data:")
    for key, value in rule_data.items():
        print(f"  {key}: {value}")

    # Get the document reference
    doc_ref = db.collection('rules').document('required_fields').collection('parents').document(rule_id)

    # Check if it already exists
    doc = doc_ref.get()
    if doc.exists:
        print(f"\n⚠️  Warning: Rule already exists!")
        print(f"Existing rule data: {doc.to_dict()}")

        response = input("\nDo you want to overwrite it? (yes/no): ")
        if response.lower() != 'yes':
            print("Aborted. No changes made.")
            return

    # Create/update the rule
    print(f"\nWriting rule to Firestore...")
    doc_ref.set(rule_data)
    print("✓ Rule created successfully!")

    # Verify creation
    created_doc = doc_ref.get()
    if created_doc.exists:
        print("✓ Verified: Rule exists in Firestore")
        print(f"\nCreated rule:")
        created_data = created_doc.to_dict()
        print(f"  Rule ID: {created_data.get('rule_id')}")
        print(f"  Entity: {created_data.get('entity')}")
        print(f"  Field: {created_data.get('field_name')} ({created_data.get('field_id')})")
        print(f"  Message: {created_data.get('message')}")
        print(f"  Severity: {created_data.get('severity')}")
        print(f"  Enabled: {created_data.get('enabled')}")
    else:
        print("✗ Warning: Rule not found after creation attempt")

    print("\n=== Next Steps ===")
    print("1. Run the delete script to remove the old relationship rule:")
    print("   python3 delete_old_parents_relationship_rule.py")
    print("\n2. Run a test scan with the parents entity to verify the new rule works")
    print("\n3. Check the frontend app to see the rule appear in the parents required fields section")

if __name__ == "__main__":
    main()
