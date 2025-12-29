#!/usr/bin/env python3
"""
Issue Count Validation Script

Analyzes recent runs and Firestore issues to verify issue counts match expectations
and detect duplicate rule_id:record_id combinations.

Usage:
    python -m backend.scripts.validate_issue_counts [--limit=10] [--run-id=xxx]
"""

import argparse
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Set

# Add project root to path
project_root = Path(__file__).parent.parent.parent
sys.path.insert(0, str(project_root))

try:
    from google.cloud import firestore
except ImportError:
    print("❌ Error: google-cloud-firestore not installed")
    print("Install with: pip install google-cloud-firestore")
    sys.exit(1)


class IssueCountValidator:
    """Validates issue counts and detects duplicates."""

    def __init__(self):
        try:
            self.db = firestore.Client()
        except Exception as e:
            print(f"❌ Error initializing Firestore: {e}")
            print("\nMake sure you have:")
            print("  1. Google Cloud credentials configured")
            print("  2. Firestore API enabled")
            sys.exit(1)

    def validate_recent_runs(self, limit: int = 10) -> None:
        """Validate issue counts for recent runs."""
        print(f"\n📊 Analyzing {limit} most recent runs...\n")

        runs_ref = self.db.collection("integrity_runs")
        recent_runs = runs_ref.order_by("started_at", direction=firestore.Query.DESCENDING).limit(limit).stream()

        for run_doc in recent_runs:
            run_data = run_doc.to_dict()
            run_id = run_doc.id
            started_at = run_data.get("started_at")
            if isinstance(started_at, datetime):
                started_str = started_at.strftime("%Y-%m-%d %H:%M:%S")
            else:
                started_str = str(started_at)

            print(f"Run: {run_id}")
            print(f"  Started: {started_str}")
            print(f"  Status: {run_data.get('status', 'unknown')}")

            # Get issues for this run
            issues_ref = self.db.collection("integrity_issues")
            run_issues = issues_ref.where("run_id", "==", run_id).stream()

            issue_list = []
            for issue_doc in run_issues:
                issue_data = issue_doc.to_dict()
                issue_list.append({
                    "rule_id": issue_data.get("rule_id", ""),
                    "record_id": issue_data.get("record_id", ""),
                    "entity": issue_data.get("entity", ""),
                    "issue_type": issue_data.get("issue_type", ""),
                })

            total_issues = len(issue_list)
            print(f"  Total issues: {total_issues}")

            # Check for duplicates
            seen_keys: Set[str] = set()
            duplicates: List[Dict[str, str]] = []
            rule_counts = defaultdict(int)

            for issue in issue_list:
                key = f"{issue['rule_id']}:{issue['record_id']}"
                rule_counts[issue['rule_id']] += 1

                if key in seen_keys:
                    duplicates.append(issue)
                else:
                    seen_keys.add(key)

            unique_count = len(seen_keys)
            duplicate_count = len(duplicates)

            if duplicate_count > 0:
                print(f"  ⚠️  Found {duplicate_count} duplicate issues!")
                print(f"  Unique issues: {unique_count}")
                print(f"  Duplicates:")
                for dup in duplicates[:10]:  # Show first 10
                    print(f"    - {dup['rule_id']}:{dup['record_id']} ({dup['entity']})")
                if len(duplicates) > 10:
                    print(f"    ... and {len(duplicates) - 10} more")
            else:
                print(f"  ✅ No duplicates found ({unique_count} unique issues)")

            # Show rule breakdown
            if rule_counts:
                print(f"  Rule breakdown:")
                for rule_id, count in sorted(rule_counts.items(), key=lambda x: x[1], reverse=True)[:10]:
                    print(f"    - {rule_id}: {count}")
                if len(rule_counts) > 10:
                    print(f"    ... and {len(rule_counts) - 10} more rules")

            print()

    def validate_specific_run(self, run_id: str) -> None:
        """Validate issue counts for a specific run."""
        print(f"\n📊 Analyzing run: {run_id}\n")

        run_ref = self.db.collection("integrity_runs").document(run_id)
        run_doc = run_ref.get()

        if not run_doc.exists:
            print(f"❌ Run {run_id} not found")
            return

        run_data = run_doc.to_dict()
        print(f"Status: {run_data.get('status', 'unknown')}")
        print(f"Started: {run_data.get('started_at', 'unknown')}")

        # Get issues for this run
        issues_ref = self.db.collection("integrity_issues")
        run_issues = issues_ref.where("run_id", "==", run_id).stream()

        issue_list = []
        for issue_doc in run_issues:
            issue_data = issue_doc.to_dict()
            issue_list.append({
                "rule_id": issue_data.get("rule_id", ""),
                "record_id": issue_data.get("record_id", ""),
                "entity": issue_data.get("entity", ""),
                "issue_type": issue_data.get("issue_type", ""),
            })

        total_issues = len(issue_list)
        print(f"Total issues: {total_issues}")

        # Check for duplicates
        seen_keys: Set[str] = set()
        duplicates: List[Dict[str, str]] = []
        rule_counts = defaultdict(int)
        entity_counts = defaultdict(int)

        for issue in issue_list:
            key = f"{issue['rule_id']}:{issue['record_id']}"
            rule_counts[issue['rule_id']] += 1
            entity_counts[issue['entity']] += 1

            if key in seen_keys:
                duplicates.append(issue)
            else:
                seen_keys.add(key)

        unique_count = len(seen_keys)
        duplicate_count = len(duplicates)

        print(f"\n📈 Summary:")
        print(f"  Total issues: {total_issues}")
        print(f"  Unique issues: {unique_count}")
        print(f"  Duplicates: {duplicate_count}")

        if duplicate_count > 0:
            print(f"\n⚠️  Duplicate issues found:")
            for dup in duplicates:
                print(f"  - {dup['rule_id']}:{dup['record_id']} ({dup['entity']}, {dup['issue_type']})")

        print(f"\n📊 By Entity:")
        for entity, count in sorted(entity_counts.items(), key=lambda x: x[1], reverse=True):
            print(f"  - {entity}: {count}")

        print(f"\n📊 By Rule (top 20):")
        for rule_id, count in sorted(rule_counts.items(), key=lambda x: x[1], reverse=True)[:20]:
            print(f"  - {rule_id}: {count}")

    def check_all_issues_for_duplicates(self, limit: int = 1000) -> None:
        """Check all issues in Firestore for duplicate rule_id:record_id combinations."""
        print(f"\n🔍 Checking all issues for duplicates (limit: {limit})...\n")

        issues_ref = self.db.collection("integrity_issues")
        all_issues = issues_ref.limit(limit).stream()

        seen_keys: Dict[str, List[Dict[str, Any]]] = defaultdict(list)

        for issue_doc in all_issues:
            issue_data = issue_doc.to_dict()
            rule_id = issue_data.get("rule_id", "")
            record_id = issue_data.get("record_id", "")
            key = f"{rule_id}:{record_id}"

            seen_keys[key].append({
                "doc_id": issue_doc.id,
                "rule_id": rule_id,
                "record_id": record_id,
                "entity": issue_data.get("entity", ""),
                "issue_type": issue_data.get("issue_type", ""),
                "run_id": issue_data.get("run_id", ""),
            })

        duplicates_found = {k: v for k, v in seen_keys.items() if len(v) > 1}

        if duplicates_found:
            print(f"⚠️  Found {len(duplicates_found)} duplicate rule_id:record_id combinations:\n")
            for key, issues in list(duplicates_found.items())[:20]:  # Show first 20
                print(f"  {key}:")
                for issue in issues:
                    print(f"    - Doc ID: {issue['doc_id']}, Run: {issue['run_id']}, Entity: {issue['entity']}")
            if len(duplicates_found) > 20:
                print(f"\n  ... and {len(duplicates_found) - 20} more duplicates")
        else:
            print("✅ No duplicate rule_id:record_id combinations found")


def main():
    parser = argparse.ArgumentParser(description="Validate issue counts and detect duplicates")
    parser.add_argument(
        "--limit",
        type=int,
        default=10,
        help="Number of recent runs to analyze (default: 10)",
    )
    parser.add_argument(
        "--run-id",
        type=str,
        help="Specific run ID to analyze",
    )
    parser.add_argument(
        "--check-all",
        action="store_true",
        help="Check all issues in Firestore for duplicates",
    )
    parser.add_argument(
        "--all-limit",
        type=int,
        default=1000,
        help="Limit for --check-all (default: 1000)",
    )

    args = parser.parse_args()

    validator = IssueCountValidator()

    if args.run_id:
        validator.validate_specific_run(args.run_id)
    elif args.check_all:
        validator.check_all_issues_for_duplicates(args.all_limit)
    else:
        validator.validate_recent_runs(args.limit)


if __name__ == "__main__":
    main()

