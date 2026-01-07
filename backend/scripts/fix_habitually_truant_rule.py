"""Script to fix the habitually truant value check rule.

Updates the existing rule to check the Student Truth table instead of Students table.
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

def fix_habitually_truant_rule():
    """Fix the habitually truant value check rule."""
    try:
        # Get project ID
        project_id = os.getenv("GCP_PROJECT_ID") or os.getenv("GOOGLE_CLOUD_PROJECT") or "data-integrity-monitor"
        print(f"Using project ID: {project_id}")

        db = firestore.Client(project=project_id)

        # Collection path
        collection_path = "rules/value_checks/absent"
        rule_id = "value_checks.absent.custom"

        # Get the existing rule
        doc_ref = db.collection(collection_path).document(rule_id)
        doc = doc_ref.get()

        if not doc.exists:
            print(f"❌ Rule {rule_id} not found. Creating new rule instead...")
            # Create new rule
            from datetime import datetime, timezone
            rule_data = {
                "rule_id": rule_id,
                "field": "Habitually Truant Status",
                "field_id": "fldbmntK4Df5TgD50",
                "field_name": "Habitually Truant Status",
                "message": "Student is marked as habitually truant",
                "severity": "info",
                "source_entity": "student_truth",
                "entity": "absent",
                "enabled": True,
                "source": "user",
                "created_at": datetime.now(timezone.utc),
                "updated_at": datetime.now(timezone.utc),
                "created_by": "system",
                "updated_by": "system",
            }
            doc_ref.set(rule_data)
            print(f"✅ Created new rule with correct configuration!")
        else:
            # Update existing rule
            print(f"Found existing rule, updating...")
            updates = {
                "field": "Habitually Truant Status",
                "field_id": "fldbmntK4Df5TgD50",
                "field_name": "Habitually Truant Status",
                "source_entity": "student_truth",
            }
            doc_ref.update(updates)
            print(f"✅ Updated rule {rule_id} with correct configuration!")

        # Read back and display
        doc = doc_ref.get()
        rule_data = doc.to_dict()
        print(f"\nRule configuration:")
        print(f"  - Rule ID: {rule_data.get('rule_id')}")
        print(f"  - Field: {rule_data.get('field')} (ID: {rule_data.get('field_id')})")
        print(f"  - Source Entity: {rule_data.get('source_entity')}")
        print(f"  - Display Entity: {rule_data.get('entity', 'absent')}")
        print(f"  - Message: {rule_data.get('message')}")
        print(f"  - Enabled: {rule_data.get('enabled')}")

        return True

    except Exception as e:
        print(f"❌ Error: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == "__main__":
    print("Fixing habitually truant value check rule...")
    print("=" * 60)
    success = fix_habitually_truant_rule()
    sys.exit(0 if success else 1)
