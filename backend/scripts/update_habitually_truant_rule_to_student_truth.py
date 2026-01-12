"""Update the habitually truant rule to be stored under student_truth entity.

This makes the rule simpler - it checks Student Truth records and displays
issues under Student Truth, without needing to cross-reference with Absent.
"""

import sys
import os
from pathlib import Path

# Add parent directory to path
backend_dir = Path(__file__).parent.parent
sys.path.insert(0, str(backend_dir.parent))

# Set environment variables from .env file
env_file = backend_dir / ".env"
if env_file.exists():
    with open(env_file, "r") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                os.environ[key] = value

from google.cloud import firestore

def update_rule():
    """Update the habitually truant value check rule."""
    try:
        # Get project ID
        project_id = os.getenv("GCP_PROJECT_ID") or os.getenv("GOOGLE_CLOUD_PROJECT") or "data-integrity-monitor"
        print(f"Using project ID: {project_id}")

        db = firestore.Client(project=project_id)

        # Delete the old rule from absent collection
        old_collection = "rules/value_checks/absent"
        old_rule_id = "value_checks.absent.custom"

        print(f"\n1. Deleting old rule from {old_collection}...")
        try:
            doc_ref = db.collection(old_collection).document(old_rule_id)
            doc = doc_ref.get()
            if doc.exists:
                doc_ref.delete()
                print(f"   ✅ Deleted old rule: {old_rule_id}")
            else:
                print(f"   ℹ️  Old rule not found (may already be deleted)")
        except Exception as e:
            print(f"   ⚠️  Could not delete old rule: {e}")

        # Create new rule under student_truth
        new_collection = "rules/value_checks/student_truth"
        new_rule_id = "value_check.student_truth.habitually_truant_status"

        print(f"\n2. Creating new rule in {new_collection}...")
        from datetime import datetime, timezone

        rule_data = {
            "rule_id": new_rule_id,
            "field": "Habitually Truant Status",
            "field_id": "fldbmntK4Df5TgD50",
            "field_name": "Habitually Truant Status",
            "message": "Student is marked as habitually truant",
            "severity": "info",
            "entity": "student_truth",
            # No source_entity needed - we're checking the same entity we're stored under
            "enabled": True,
            "source": "user",
            "created_at": datetime.now(timezone.utc),
            "updated_at": datetime.now(timezone.utc),
            "created_by": "system",
            "updated_by": "system",
        }

        doc_ref = db.collection(new_collection).document(new_rule_id)
        doc_ref.set(rule_data)
        print(f"   ✅ Created new rule!")

        # Read back and display
        doc = doc_ref.get()
        rule_data = doc.to_dict()

        print(f"\n3. New rule configuration:")
        print(f"   - Rule ID: {rule_data.get('rule_id')}")
        print(f"   - Collection: {new_collection}")
        print(f"   - Field: {rule_data.get('field')} (ID: {rule_data.get('field_id')})")
        print(f"   - Entity: {rule_data.get('entity')}")
        print(f"   - Source Entity: {rule_data.get('source_entity', 'NONE (same as entity)')}")
        print(f"   - Message: {rule_data.get('message')}")
        print(f"   - Enabled: {rule_data.get('enabled')}")

        print(f"\n✅ Successfully updated habitually truant rule!")
        print(f"\nNOTE: The rule is now under the 'student_truth' entity.")
        print(f"      Select 'student_truth' (not 'absent') when running scans.")

        return True

    except Exception as e:
        print(f"❌ Error: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == "__main__":
    print("Updating habitually truant value check rule...")
    print("=" * 60)
    success = update_rule()
    sys.exit(0 if success else 1)
