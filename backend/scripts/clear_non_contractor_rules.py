#!/usr/bin/env python3
"""Clear all non-contractor rules from Firestore."""

import sys
import os

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from clients.firestore import FirestoreClient
from config.config_loader import load_runtime_config

def main():
    print("Loading runtime config...")
    runtime_config = load_runtime_config()

    print("Initializing Firestore client...")
    client = FirestoreClient(runtime_config.firestore)

    print("\n=== BEFORE: Current rules in Firestore ===")
    current_rules = client.get_rules()
    print(f"Duplicates entities: {list(current_rules.get('duplicates', {}).keys())}")
    print(f"Relationships entities: {list(current_rules.get('relationships', {}).keys())}")
    print(f"Required fields entities: {list(current_rules.get('required_fields', {}).keys())}")

    # Create contractors-only rules
    contractors_only_rules = {
        "duplicates": {
            "contractors": current_rules.get("duplicates", {}).get("contractors", {})
        },
        "relationships": {},  # No relationships for contractors-only
        "required_fields": {
            "contractors": current_rules.get("required_fields", {}).get("contractors", {})
        }
    }

    print("\n=== Updating Firestore with contractors-only rules ===")
    client.save_rules(contractors_only_rules)

    print("\n=== AFTER: Verifying updated rules ===")
    updated_rules = client.get_rules()
    print(f"Duplicates entities: {list(updated_rules.get('duplicates', {}).keys())}")
    print(f"Relationships entities: {list(updated_rules.get('relationships', {}).keys())}")
    print(f"Required fields entities: {list(updated_rules.get('required_fields', {}).keys())}")

    print("\n✓ Successfully updated Firestore rules to contractors-only!")

if __name__ == "__main__":
    main()
