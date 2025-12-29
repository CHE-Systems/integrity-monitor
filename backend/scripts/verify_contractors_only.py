#!/usr/bin/env python3
"""
Verify that only contractor rules exist in the system.

This script checks both YAML configs and Firestore to ensure no non-contractor
rules exist anywhere in the system.

Usage:
    python -m backend.scripts.verify_contractors_only
"""

import sys
import os
import logging
from google.cloud import firestore

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from config.config_loader import load_runtime_config
from config.schema_loader import load_schema_config

logging.basicConfig(
    level=logging.INFO,
    format='%(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

ALLOWED_ENTITY = "contractors"
DISALLOWED_ENTITIES = [
    "students", "parents", "classes", "attendance", "truth", "campuses", "payments"
]


def verify_schema_yaml():
    """Verify schema.yaml only has contractor entities."""
    logger.info("\n=== Checking schema.yaml ===")

    try:
        import yaml
        from pathlib import Path

        schema_path = Path(__file__).parent.parent / "config" / "schema.yaml"
        with open(schema_path) as f:
            schema = yaml.safe_load(f)

        entities = list(schema.get("entities", {}).keys())
        duplicate_entities = list(schema.get("duplicates", {}).keys())

        issues = []

        # Check entities
        for entity in entities:
            if entity != ALLOWED_ENTITY:
                issues.append(f"  ✗ Found non-contractor entity: {entity}")

        # Check duplicates
        for entity in duplicate_entities:
            if entity != ALLOWED_ENTITY:
                issues.append(f"  ✗ Found non-contractor duplicate rules: {entity}")

        if issues:
            for issue in issues:
                logger.error(issue)
            return False
        else:
            logger.info(f"  ✓ Only {ALLOWED_ENTITY} entity found")
            logger.info(f"  ✓ Entities: {entities}")
            logger.info(f"  ✓ Duplicate entities: {duplicate_entities}")

            # Count rules
            contractor_entity = schema.get("entities", {}).get(ALLOWED_ENTITY, {})
            if contractor_entity:
                required_fields = len(contractor_entity.get("missing_key_data", []))
                relationships = len(contractor_entity.get("relationships", {}))
                logger.info(f"  ✓ Required fields: {required_fields}")
                logger.info(f"  ✓ Relationships: {relationships}")

            contractor_dups = schema.get("duplicates", {}).get(ALLOWED_ENTITY, {})
            if contractor_dups:
                likely = len(contractor_dups.get("likely", []))
                possible = len(contractor_dups.get("possible", []))
                logger.info(f"  ✓ Duplicate rules: {likely} likely, {possible} possible")

            return True
    except Exception as exc:
        logger.error(f"Failed to verify schema: {exc}", exc_info=True)
        return False


def verify_rules_yaml():
    """Verify rules.yaml only has contractor config."""
    logger.info("\n=== Checking rules.yaml ===")
    runtime_config = load_runtime_config()

    # AirtableConfig is a RootModel wrapping a dict, access via .root
    airtable_configs = list(runtime_config.airtable.root.keys())

    issues = []

    # Check Airtable configs
    for entity in airtable_configs:
        if entity != ALLOWED_ENTITY:
            issues.append(f"  ✗ Found non-contractor Airtable config: {entity}")

    # Check attendance thresholds
    if runtime_config.attendance_rules.thresholds:
        issues.append(f"  ✗ Found attendance thresholds: {list(runtime_config.attendance_rules.thresholds.keys())}")

    if issues:
        for issue in issues:
            logger.error(issue)
        return False
    else:
        logger.info(f"  ✓ Only {ALLOWED_ENTITY} Airtable config found")
        logger.info(f"  ✓ Airtable configs: {airtable_configs}")
        logger.info(f"  ✓ Attendance thresholds: empty")
        return True


def verify_firestore():
    """Verify Firestore only has contractor rules."""
    logger.info("\n=== Checking Firestore ===")

    try:
        db = firestore.Client()
        issues = []
        contractor_rules = {"duplicates": 0, "relationships": 0, "required_fields": 0}

        # Check each rule category
        for category in ["duplicates", "relationships", "required_fields"]:
            # Check for non-contractor entities
            for entity in DISALLOWED_ENTITIES:
                collection_path = f"rules/{category}/{entity}"
                entity_rules_ref = db.collection(collection_path)
                docs = list(entity_rules_ref.stream())

                if docs:
                    issues.append(f"  ✗ Found {len(docs)} {category} rules for {entity}")

            # Count contractor rules
            collection_path = f"rules/{category}/{ALLOWED_ENTITY}"
            contractor_rules_ref = db.collection(collection_path)
            contractor_docs = list(contractor_rules_ref.stream())
            contractor_rules[category] = len(contractor_docs)

        # Check attendance thresholds
        attendance_ref = db.collection("rules").document("attendance_thresholds")
        attendance_doc = attendance_ref.get()
        if attendance_doc.exists:
            data = attendance_doc.to_dict()
            thresholds = data.get("thresholds", {})
            if thresholds:
                issues.append(f"  ✗ Found {len(thresholds)} attendance thresholds")

        if issues:
            for issue in issues:
                logger.error(issue)
            return False
        else:
            logger.info(f"  ✓ No non-contractor rules found in Firestore")
            logger.info(f"  ✓ Contractor duplicates: {contractor_rules['duplicates']}")
            logger.info(f"  ✓ Contractor relationships: {contractor_rules['relationships']}")
            logger.info(f"  ✓ Contractor required_fields: {contractor_rules['required_fields']}")
            logger.info(f"  ✓ Total contractor rules: {sum(contractor_rules.values())}")
            return True

    except Exception as exc:
        logger.error(f"Failed to verify Firestore: {exc}", exc_info=True)
        return False


def main():
    logger.info("="*70)
    logger.info("CONTRACTORS-ONLY VERIFICATION")
    logger.info("="*70)

    schema_ok = verify_schema_yaml()
    rules_ok = verify_rules_yaml()
    firestore_ok = verify_firestore()

    logger.info("\n" + "="*70)
    logger.info("VERIFICATION SUMMARY")
    logger.info("="*70)
    logger.info(f"schema.yaml:  {'✓ PASS' if schema_ok else '✗ FAIL'}")
    logger.info(f"rules.yaml:   {'✓ PASS' if rules_ok else '✗ FAIL'}")
    logger.info(f"Firestore:    {'✓ PASS' if firestore_ok else '✗ FAIL'}")
    logger.info("="*70)

    if schema_ok and rules_ok and firestore_ok:
        logger.info("\n✅ All checks passed! System is contractors-only.")
        return 0
    else:
        logger.error("\n❌ Some checks failed. Non-contractor rules still exist.")
        return 1


if __name__ == "__main__":
    sys.exit(main())
