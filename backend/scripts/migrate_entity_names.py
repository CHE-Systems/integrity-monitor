#!/usr/bin/env python3
"""
Migrate rules in Firestore from singular to plural entity names.

This script:
1. Finds all rules stored with singular entity names (contractor, student, parent)
2. Moves them to plural entity names (contractors, students, parents)
3. Updates the entity field in the rule data
4. Optionally deletes the old singular collections

Usage:
    python -m backend.scripts.migrate_entity_names [--dry-run] [--delete-old]
"""

import argparse
import logging
import sys
from pathlib import Path
from typing import Dict, List

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from google.cloud import firestore
from datetime import datetime, timezone

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Entity name mappings: singular -> plural
ENTITY_MAPPINGS = {
    "contractor": "contractors",
    "student": "students",
    "parent": "parents",
}

# Rule categories to migrate
RULE_CATEGORIES = ["duplicates", "relationships", "required_fields"]


def migrate_entity_names(dry_run: bool = True, delete_old: bool = False):
    """Migrate rules from singular to plural entity names."""
    try:
        db = firestore.Client()
    except Exception as exc:
        logger.error(f"Failed to initialize Firestore client: {exc}")
        return

    total_migrated = 0
    total_errors = 0

    for category in RULE_CATEGORIES:
        logger.info(f"\n{'='*60}")
        logger.info(f"Migrating {category} rules")
        logger.info(f"{'='*60}")

        for singular, plural in ENTITY_MAPPINGS.items():
            old_collection_path = f"rules/{category}/{singular}"
            new_collection_path = f"rules/{category}/{plural}"

            try:
                # Get all documents from old collection
                old_collection = db.collection(old_collection_path)
                old_docs = old_collection.stream()

                doc_count = 0
                for old_doc in old_docs:
                    doc_count += 1
                    rule_data = old_doc.to_dict()
                    rule_id = old_doc.id

                    if not rule_data:
                        logger.warning(f"Skipping empty document {rule_id} in {old_collection_path}")
                        continue

                    # Update entity field in rule data
                    if "entity" in rule_data:
                        if rule_data["entity"] == singular:
                            rule_data["entity"] = plural
                        else:
                            logger.warning(
                                f"Rule {rule_id} has entity={rule_data['entity']}, expected {singular}"
                            )

                    # Update source_entity for relationships
                    if "source_entity" in rule_data:
                        if rule_data["source_entity"] == singular:
                            rule_data["source_entity"] = plural

                    # Update updated_at timestamp
                    rule_data["updated_at"] = datetime.now(timezone.utc)
                    rule_data["updated_by"] = "migration_script"

                    if dry_run:
                        logger.info(
                            f"  [DRY RUN] Would migrate {rule_id} from {old_collection_path} to {new_collection_path}"
                        )
                    else:
                        # Write to new collection
                        new_doc_ref = db.collection(new_collection_path).document(rule_id)
                        new_doc_ref.set(rule_data)
                        logger.info(f"  ✅ Migrated {rule_id} to {new_collection_path}")

                        # Delete from old collection if requested
                        if delete_old:
                            old_doc.reference.delete()
                            logger.info(f"  🗑️  Deleted {rule_id} from {old_collection_path}")

                    total_migrated += 1

                if doc_count == 0:
                    logger.debug(f"  No documents found in {old_collection_path}")
                else:
                    logger.info(f"  Found {doc_count} document(s) in {old_collection_path}")

            except Exception as exc:
                logger.error(f"  ❌ Error migrating {old_collection_path}: {exc}", exc_info=True)
                total_errors += 1

    logger.info(f"\n{'='*60}")
    logger.info(f"Migration Summary")
    logger.info(f"{'='*60}")
    logger.info(f"Total rules migrated: {total_migrated}")
    logger.info(f"Total errors: {total_errors}")
    
    if dry_run:
        logger.info("\n⚠️  DRY RUN - No changes were made")
        logger.info("Run without --dry-run to apply changes")
    elif delete_old:
        logger.info("\n✅ Migration complete - old collections deleted")
    else:
        logger.info("\n✅ Migration complete - old collections preserved")
        logger.info("Run with --delete-old to remove old collections")


def main():
    parser = argparse.ArgumentParser(
        description="Migrate rules from singular to plural entity names"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Preview changes without applying them"
    )
    parser.add_argument(
        "--delete-old",
        action="store_true",
        help="Delete old collections after migration (only works if not dry-run)"
    )

    args = parser.parse_args()

    if args.delete_old and args.dry_run:
        logger.warning("--delete-old has no effect in dry-run mode")

    migrate_entity_names(dry_run=args.dry_run, delete_old=args.delete_old)


if __name__ == "__main__":
    main()

