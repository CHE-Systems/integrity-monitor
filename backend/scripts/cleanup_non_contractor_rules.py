#!/usr/bin/env python3
"""
Remove all non-contractor rules from Firestore.

This script deletes all rules for entities other than contractors from the Firestore
integrity rules collections. Use this when you want to ensure only contractor rules
exist in the system.

Usage:
    python -m backend.scripts.cleanup_non_contractor_rules [--dry-run] [--confirm]
"""

import argparse
import logging
from google.cloud import firestore

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Only this entity should remain
ALLOWED_ENTITY = "contractors"

# All other entities to remove
ENTITIES_TO_REMOVE = [
    "students",
    "parents",
    "classes",
    "attendance",
    "truth",
    "campuses",
    "payments",
]

# Rule categories in Firestore
RULE_CATEGORIES = ["duplicates", "relationships", "required_fields"]


def cleanup_firestore_rules(dry_run: bool = True, confirm: bool = False):
    """Remove all non-contractor rules from Firestore."""

    if not dry_run and not confirm:
        logger.error("Must pass --confirm flag to actually delete rules")
        return

    mode = "DRY RUN" if dry_run else "LIVE MODE"
    logger.info(f"Starting cleanup in {mode}")
    logger.info(f"Will preserve: {ALLOWED_ENTITY}")
    logger.info(f"Will remove: {', '.join(ENTITIES_TO_REMOVE)}")

    try:
        db = firestore.Client()
        deleted_count = 0
        preserved_count = 0

        # Clean each rule category
        for category in RULE_CATEGORIES:
            logger.info(f"\n=== Cleaning {category} rules ===")

            # Get all documents in this category
            rules_ref = db.collection("rules").document(category)

            # Check each entity subcollection
            for entity in ENTITIES_TO_REMOVE + [ALLOWED_ENTITY]:
                collection_path = f"rules/{category}/{entity}"
                entity_rules_ref = db.collection(collection_path)

                # Get all rules for this entity
                docs = list(entity_rules_ref.stream())

                if not docs:
                    continue

                if entity == ALLOWED_ENTITY:
                    # Preserve contractor rules
                    logger.info(f"  ✓ Preserving {len(docs)} {entity} rules")
                    preserved_count += len(docs)
                else:
                    # Delete non-contractor rules
                    logger.info(f"  ✗ {'Would delete' if dry_run else 'Deleting'} {len(docs)} {entity} rules")

                    if not dry_run:
                        for doc in docs:
                            doc.reference.delete()
                            logger.debug(f"    Deleted: {doc.id}")

                    deleted_count += len(docs)

        # Clean attendance rules (separate structure)
        logger.info(f"\n=== Cleaning attendance rules ===")
        attendance_ref = db.collection("rules").document("attendance_thresholds")

        try:
            attendance_doc = attendance_ref.get()
            if attendance_doc.exists:
                data = attendance_doc.to_dict()
                thresholds = data.get("thresholds", {})

                if thresholds:
                    logger.info(f"  ✗ {'Would clear' if dry_run else 'Clearing'} {len(thresholds)} attendance thresholds")

                    if not dry_run:
                        attendance_ref.update({"thresholds": {}})

                    deleted_count += len(thresholds)
                else:
                    logger.info(f"  ✓ No attendance thresholds to clean")
        except Exception as e:
            logger.warning(f"  Could not access attendance rules: {e}")

        # Summary
        logger.info(f"\n=== Summary ({mode}) ===")
        logger.info(f"Preserved {ALLOWED_ENTITY} rules: {preserved_count}")
        logger.info(f"{'Would delete' if dry_run else 'Deleted'} non-contractor rules: {deleted_count}")

        if dry_run:
            logger.info("\nThis was a dry run. Use --confirm to actually delete.")
        else:
            logger.info("\n✓ Cleanup completed successfully!")

    except Exception as exc:
        logger.error(f"Failed to cleanup rules: {exc}", exc_info=True)
        raise


def main():
    parser = argparse.ArgumentParser(
        description="Remove all non-contractor rules from Firestore"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be deleted without actually deleting"
    )
    parser.add_argument(
        "--confirm",
        action="store_true",
        help="Actually delete rules (required for non-dry-run mode)"
    )

    args = parser.parse_args()

    # If neither flag is provided, default to dry run
    if not args.dry_run and not args.confirm:
        args.dry_run = True

    cleanup_firestore_rules(dry_run=args.dry_run, confirm=args.confirm)


if __name__ == "__main__":
    main()
