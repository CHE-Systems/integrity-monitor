"""Script to create the habitually truant value check rule in Firestore.

This rule checks the Students table for the "Habitually Truant Status" field
and flags students who have a value in that field. The rule is displayed
under the "Absent" entity tab but checks the "Students" table.
"""

import sys
import os
from pathlib import Path
from datetime import datetime, timezone

# Add parent directory to path
backend_dir = Path(__file__).parent.parent
sys.path.insert(0, str(backend_dir.parent))

from google.cloud import firestore
from backend.services.rules_service import RulesService


def create_habitually_truant_rule():
    """Create the habitually truant value check rule."""
    try:
        # Get project ID from environment
        project_id = os.getenv("GCP_PROJECT_ID") or os.getenv("GOOGLE_CLOUD_PROJECT")
        if not project_id:
            print("❌ Error: GCP_PROJECT_ID or GOOGLE_CLOUD_PROJECT environment variable not set")
            print("   Please set one of these environment variables and try again")
            return None
        
        db = firestore.Client(project=project_id)
        rules_service = RulesService()
        rules_service.db = db  # Override the db with the properly initialized client
        
        # Rule data
        rule_data = {
            "field": "HABITUALLY_TRUANT_STATUS",
            "field_id": "fldbmntK4Df5TgD50",  # From schema
            "message": "Student is marked as habitually truant",
            "severity": "info",
            "source_entity": "students",  # Check students table
            "enabled": True,
        }
        
        # Create the rule using the rules service
        # Entity is "absent" (where rule is displayed), but source_entity is "students" (what to check)
        created_rule = rules_service.create_rule(
            category="value_checks",
            entity="absent",
            rule_data=rule_data,
            user_id="system"
        )
        
        print("✅ Successfully created habitually truant rule!")
        print(f"   Rule ID: {created_rule.get('rule_id')}")
        print(f"   Firestore path: rules/value_checks/absent/{created_rule.get('rule_id')}")
        print(f"   Field: {created_rule.get('field')}")
        print(f"   Source Entity: {created_rule.get('source_entity')}")
        print(f"   Message: {created_rule.get('message')}")
        
        return created_rule
        
    except Exception as e:
        print(f"❌ Error creating rule: {e}")
        import traceback
        traceback.print_exc()
        return None


if __name__ == "__main__":
    print("Creating habitually truant value check rule...")
    print("=" * 60)
    create_habitually_truant_rule()

