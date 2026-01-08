#!/usr/bin/env python3
"""
Rules Snapshot Script

Creates a snapshot/backup of Firestore rules to a YAML file.
This is a read-only operation - it does not modify Firestore.

Usage:
    python -m backend.scripts.migrate_rules --output schema.yaml.snapshot
    python -m backend.scripts.migrate_rules --output rules-backup-2024-01-01.yaml
"""

import argparse
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Dict

import yaml

# Add project root to path
project_root = Path(__file__).parent.parent.parent
sys.path.insert(0, str(project_root))

from backend.config.config_loader import load_runtime_config
from backend.clients.firestore import FirestoreClient
from backend.services.rules_service import RulesService


class RulesSnapshot:
    """Creates snapshot/backup of Firestore rules to YAML file."""

    def __init__(self, output_path: Path):
        self.output_path = output_path

        # Initialize Firestore client
        try:
            runtime_config = load_runtime_config(attempt_discovery=True)
            firestore_client = FirestoreClient(runtime_config.firestore)
            self.rules_service = RulesService(firestore_client)
        except Exception as e:
            print(f"❌ Error initializing Firestore: {e}")
            print("\nMake sure you have:")
            print("1. Installed google-cloud-firestore: pip install google-cloud-firestore")
            print("2. Set up credentials:")
            print("   - gcloud auth application-default login")
            print("   - OR set GOOGLE_APPLICATION_CREDENTIALS environment variable")
            raise

    def snapshot(self) -> None:
        """Export all Firestore rules to YAML file."""
        print("\n" + "=" * 70)
        print("RULES SNAPSHOT: Firestore → YAML")
        print("=" * 70)
        print(f"\nOutput file: {self.output_path}")
        print()

        # Load rules from Firestore
        print("Loading rules from Firestore...")
        try:
            rules_data = self.rules_service.get_all_rules()
        except Exception as e:
            print(f"❌ Error loading rules from Firestore: {e}")
            raise

        # Convert to YAML format
        print("Converting to YAML format...")
        yaml_data = self._convert_to_yaml_format(rules_data)

        # Check if output file exists
        if self.output_path.exists():
            response = input(
                f"⚠️  File {self.output_path} already exists. Overwrite? (y/N): "
            )
            if response.lower() != "y":
                print("❌ Aborted. Use a different output path.")
                sys.exit(1)

        # Write to file
        print(f"Writing snapshot to {self.output_path}...")
        try:
            with open(self.output_path, "w", encoding="utf-8") as f:
                yaml.dump(yaml_data, f, default_flow_style=False, sort_keys=False, allow_unicode=True)
        except Exception as e:
            print(f"❌ Error writing to file: {e}")
            raise

        # Print summary
        self._print_summary(rules_data)

        print(f"\n✅ Snapshot created successfully: {self.output_path}")

    def _convert_to_yaml_format(self, rules_data: Dict[str, Any]) -> Dict[str, Any]:
        """Convert Firestore rules structure to YAML format (matching old schema.yaml structure)."""
        yaml_data = {
            "metadata": {
                "source": "firestore_snapshot",
                "generated": datetime.now().isoformat(),
                "note": "This is a snapshot/backup of Firestore rules. Rules are managed in Firestore only.",
            },
            "entities": {},
            "duplicates": {},
        }

        # Get all entities
        all_entities = set()
        if "relationships" in rules_data:
            all_entities.update(rules_data["relationships"].keys())
        if "required_fields" in rules_data:
            all_entities.update(rules_data["required_fields"].keys())
        if "value_checks" in rules_data:
            all_entities.update(rules_data["value_checks"].keys())
        if "duplicates" in rules_data:
            all_entities.update(rules_data["duplicates"].keys())

        # Build entities section
        for entity in all_entities:
            entity_data = {
                "description": f"{entity.capitalize()} entity",
                "key_identifiers": [],
                "identity_fields": [],
                "relationships": {},
                "missing_key_data": [],
                "value_checks": [],
            }

            # Add relationships
            if "relationships" in rules_data and entity in rules_data["relationships"]:
                for rel_key, rel_data in rules_data["relationships"][entity].items():
                    entity_data["relationships"][rel_key] = {
                        "target": rel_data.get("target", ""),
                        "message": rel_data.get("message", ""),
                        "min_links": rel_data.get("min_links", 0),
                        "max_links": rel_data.get("max_links"),
                        "require_active": rel_data.get("require_active", False),
                        "allow_secondary": rel_data.get("allow_secondary", False),
                        "condition_field": rel_data.get("condition_field"),
                        "condition_value": rel_data.get("condition_value"),
                        "notes": rel_data.get("notes"),
                        "validate_bidirectional": rel_data.get("validate_bidirectional", False),
                        "reverse_relationship_key": rel_data.get("reverse_relationship_key"),
                        "cross_entity_validation": rel_data.get("cross_entity_validation"),
                    }
                    # Remove None values
                    entity_data["relationships"][rel_key] = {
                        k: v for k, v in entity_data["relationships"][rel_key].items() if v is not None
                    }

            # Add required fields (missing_key_data)
            if "required_fields" in rules_data and entity in rules_data["required_fields"]:
                for req_data in rules_data["required_fields"][entity]:
                    field_req = {
                        "field": req_data.get("field_id") or req_data.get("field", ""),
                        "rule_id": req_data.get("rule_id"),
                        "message": req_data.get("message", ""),
                        "severity": req_data.get("severity", "warning"),
                        "alternate_fields": req_data.get("alternate_fields"),
                        "condition_field": req_data.get("condition_field"),
                        "condition_value": req_data.get("condition_value"),
                    }
                    # Remove None values
                    field_req = {k: v for k, v in field_req.items() if v is not None}
                    entity_data["missing_key_data"].append(field_req)

            # Add value checks
            if "value_checks" in rules_data and entity in rules_data["value_checks"]:
                for check_data in rules_data["value_checks"][entity]:
                    value_check = {
                        "field": check_data.get("field_id") or check_data.get("field", ""),
                        "rule_id": check_data.get("rule_id"),
                        "message": check_data.get("message", ""),
                        "severity": check_data.get("severity", "info"),
                        "source_entity": check_data.get("source_entity"),
                        "condition_field": check_data.get("condition_field"),
                        "condition_value": check_data.get("condition_value"),
                    }
                    # Remove None values
                    value_check = {k: v for k, v in value_check.items() if v is not None}
                    entity_data["value_checks"].append(value_check)

            # Only add entity if it has rules
            if (
                entity_data["relationships"]
                or entity_data["missing_key_data"]
                or entity_data["value_checks"]
            ):
                yaml_data["entities"][entity] = entity_data

        # Build duplicates section
        if "duplicates" in rules_data:
            for entity, dup_data in rules_data["duplicates"].items():
                dup_def = {"likely": [], "possible": []}

                # Process likely duplicates
                if "likely" in dup_data:
                    for rule_data in dup_data["likely"]:
                        rule = {
                            "rule_id": rule_data.get("rule_id", ""),
                            "description": rule_data.get("description", ""),
                            "conditions": [],
                            "severity": rule_data.get("severity", "warning"),
                        }
                        for cond_data in rule_data.get("conditions", []):
                            condition = {
                                "type": cond_data.get("match_type") or cond_data.get("type", "exact"),
                                "field": cond_data.get("field"),
                                "fields": cond_data.get("fields"),
                                "tolerance_days": cond_data.get("tolerance_days"),
                                "similarity": cond_data.get("similarity"),
                                "overlap_ratio": cond_data.get("overlap_ratio"),
                                "description": cond_data.get("description"),
                            }
                            # Remove None values
                            condition = {k: v for k, v in condition.items() if v is not None}
                            rule["conditions"].append(condition)
                        dup_def["likely"].append(rule)

                # Process possible duplicates
                if "possible" in dup_data:
                    for rule_data in dup_data["possible"]:
                        rule = {
                            "rule_id": rule_data.get("rule_id", ""),
                            "description": rule_data.get("description", ""),
                            "conditions": [],
                            "severity": rule_data.get("severity", "warning"),
                        }
                        for cond_data in rule_data.get("conditions", []):
                            condition = {
                                "type": cond_data.get("match_type") or cond_data.get("type", "exact"),
                                "field": cond_data.get("field"),
                                "fields": cond_data.get("fields"),
                                "tolerance_days": cond_data.get("tolerance_days"),
                                "similarity": cond_data.get("similarity"),
                                "overlap_ratio": cond_data.get("overlap_ratio"),
                                "description": cond_data.get("description"),
                            }
                            # Remove None values
                            condition = {k: v for k, v in condition.items() if v is not None}
                            rule["conditions"].append(condition)
                        dup_def["possible"].append(rule)

                if dup_def["likely"] or dup_def["possible"]:
                    yaml_data["duplicates"][entity] = dup_def

        return yaml_data

    def _print_summary(self, rules_data: Dict[str, Any]) -> None:
        """Print summary of exported rules."""
        print("\n" + "-" * 70)
        print("SNAPSHOT SUMMARY")
        print("-" * 70)

        # Count duplicates
        duplicates_count = 0
        for dup_data in rules_data.get("duplicates", {}).values():
            duplicates_count += len(dup_data.get("likely", [])) + len(dup_data.get("possible", []))

        # Count relationships
        relationships_count = sum(
            len(r) for r in rules_data.get("relationships", {}).values()
        )

        # Count required fields
        required_fields_count = sum(
            len(r) for r in rules_data.get("required_fields", {}).values()
        )

        # Count value checks
        value_checks_count = sum(
            len(r) for r in rules_data.get("value_checks", {}).values()
        )

        print(f"  Duplicates:        {duplicates_count}")
        print(f"  Relationships:    {relationships_count}")
        print(f"  Required Fields:   {required_fields_count}")
        print(f"  Value Checks:      {value_checks_count}")
        print(f"  Total Rules:       {duplicates_count + relationships_count + required_fields_count + value_checks_count}")


def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="Create snapshot/backup of Firestore rules to YAML file",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Create snapshot with default name
  python -m backend.scripts.migrate_rules --output schema.yaml.snapshot

  # Create timestamped backup
  python -m backend.scripts.migrate_rules --output rules-backup-2024-01-01.yaml

  # Create snapshot in specific directory
  python -m backend.scripts.migrate_rules --output backups/rules-snapshot.yaml
        """,
    )

    parser.add_argument(
        "--output",
        "-o",
        type=str,
        default="schema.yaml.snapshot",
        help="Output file path for the snapshot (default: schema.yaml.snapshot)",
    )

    args = parser.parse_args()

    output_path = Path(args.output)

    try:
        snapshot = RulesSnapshot(output_path)
        snapshot.snapshot()
    except KeyboardInterrupt:
        print("\n\n❌ Interrupted by user")
        sys.exit(1)
    except Exception as e:
        print(f"\n❌ Error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
