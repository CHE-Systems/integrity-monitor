#!/usr/bin/env python3
"""
Convert classes->students relationship rule to required field rule.

This script specifically converts the "classes must have at least one enrolled student"
relationship rule to a required field rule that checks if the "Student" field is populated.
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
print("Convert Classes->Students Relationship Rule to Required Field Rule")
print("=" * 80)
print()

entity = "classes"
field_name = "Student"  # Field name in Airtable Classes table
collection_path = f"rules/relationships/{entity}"

try:
    # Get all relationship rules for classes
    docs = list(db.collection(collection_path).stream())
    
    if not docs:
        print(f"❌ No relationship rules found for {entity}")
        sys.exit(0)
    
    print(f"📁 Entity: {entity}")
    print(f"   Found {len(docs)} relationship rule(s)")
    
    # Find the students relationship rule
    students_rule = None
    for doc in docs:
        rule_data = doc.to_dict()
        rule_id = doc.id
        target = rule_data.get("target", "").lower()
        
        # Check if this is the students relationship rule
        # Could be "students", "student", or doc ID contains "student"
        if "student" in target.lower() or "student" in rule_id.lower():
            students_rule = (doc, rule_data, rule_id)
            break
    
    if not students_rule:
        print(f"❌ No students relationship rule found for {entity}")
        print(f"   Available rules: {[doc.id for doc in docs]}")
        sys.exit(0)
    
    doc, rule_data, rule_id = students_rule
    target = rule_data.get("target", "")
    message = rule_data.get("message", "") or rule_data.get("description", "")
    
    print(f"\n   Found students relationship rule: {rule_id}")
    print(f"      Target: {target}")
    print(f"      Message: {message}")
    
    # Create required field rule
    required_field_rule_id = f"required_field_rule.{entity}.{field_name.lower()}"
    required_field_collection = f"rules/required_fields/{entity}"
    
    # Check if required field rule already exists
    req_doc_ref = db.collection(required_field_collection).document(required_field_rule_id)
    if req_doc_ref.get().exists:
        print(f"\n   ⚪ Required field rule already exists: {required_field_rule_id}")
        print(f"      Skipping conversion")
    else:
        # Create the required field rule
        # Use the message from the relationship rule, or create a default one
        default_message = f"Classes must have at least one enrolled student."
        rule_message = message or default_message
        
        required_field_data = {
            "rule_id": required_field_rule_id,
            "entity": entity,
            "field": field_name,  # Use "Student" as the field name
            "field_name": field_name,
            "severity": "warning",
            "message": rule_message,
            "description": f"Check that {field_name} field is populated with at least one student.",
            "enabled": True,
            "source": "relationship_conversion",
            "created_at": datetime.now(timezone.utc),
            "updated_at": datetime.now(timezone.utc),
            "created_by": "conversion_script",
            "updated_by": "conversion_script",
            "converted_from": rule_id,
        }
        
        req_doc_ref.set(required_field_data)
        print(f"\n   ✓ Created required field rule: {required_field_rule_id}")
        print(f"      Field: {field_name}")
        print(f"      Message: {rule_message}")
    
    # Delete the original relationship rule
    doc.reference.delete()
    print(f"\n   ✓ Deleted relationship rule: {rule_id}")
    
    print("\n" + "=" * 80)
    print("Conversion Complete")
    print("=" * 80)
    print(f"\n✅ Converted classes->students relationship rule to required field rule")
    print(f"✅ Deleted original relationship rule")
    print("\nNext steps:")
    print("1. Restart backend")
    print("2. Test scans - the rule should now check if Student field is populated")

except Exception as exc:
    print(f"❌ Error processing {entity}: {exc}")
    import traceback
    traceback.print_exc()
    sys.exit(1)
