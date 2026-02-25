"""Seed duplicate detection rules for Student Truth table.

Two rules:
  Rule 1 (main): Same DOB + name similarity >= 0.95 + same school year.
    Catches campus-linked students duplicated within the same year.

  Rule 2 (unsure fallback): Same DOB + name similarity >= 0.95 + both "Unsure".
    Catches students with no campus/year who are likely the same person.

Usage:
  python -m backend.scripts.seed_student_truth_duplicate_rule
"""

import logging
from google.cloud import firestore

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


STUDENT_TRUTH_DUPLICATE_RULES = [
    {
        "rule_id": "dup.student_truth.dob_name_school_year",
        "description": "Duplicate Student Truth: records with matching DOB, similar name, and same school year — likely the same student enrolled twice.",
        "entity": "student_truth",
        "severity": "likely",
        "enabled": True,
        "conditions": [
            {"type": "exact_match", "field": "Student's Birthdate (from Student)", "field_id": "fldWvaET7Lu3g06tO"},
            {"type": "similarity", "field": "Last, First, Middle Name", "field_id": "fld5elEqYC2y7ZgUV", "similarity": 0.95},
            {"type": "exact_match", "field": "School Year", "field_id": "fldpagtV48mBEGUT7"},
        ],
    },
    {
        "rule_id": "dup.student_truth.dob_name_unsure",
        "description": "Duplicate Student Truth: records with matching DOB, similar name, and both with Unsure enrollment status — likely the same student enrolled twice (no campus/year linked).",
        "entity": "student_truth",
        "severity": "likely",
        "enabled": True,
        "conditions": [
            {"type": "exact_match", "field": "Student's Birthdate (from Student)", "field_id": "fldWvaET7Lu3g06tO"},
            {"type": "similarity", "field": "Last, First, Middle Name", "field_id": "fld5elEqYC2y7ZgUV", "similarity": 0.95},
            {"type": "value_equals", "field": "Status of Enrollment", "field_id": "fld7vz1KYGYM3Q4qd", "value": "Unsure"},
        ],
    },
]


OLD_RULE_IDS = [
    "dup.student_truth.school_year_campus_name_dob",
    "dup.student_truth.student_school_year_campus",
]


def seed_rules():
    """Seed duplicate detection rules for student_truth in Firestore."""
    db = firestore.Client()

    collection_path = "rules/duplicates/student_truth"
    collection_ref = db.collection(collection_path)

    # Clean up old rules that have been replaced
    for old_rule_id in OLD_RULE_IDS:
        old_doc_ref = collection_ref.document(old_rule_id)
        old_doc = old_doc_ref.get()
        if old_doc.exists:
            logger.info(f"Deleting old rule: {collection_path}/{old_rule_id}")
            old_doc_ref.delete()

    for rule in STUDENT_TRUTH_DUPLICATE_RULES:
        rule_id = rule["rule_id"]
        doc_ref = collection_ref.document(rule_id)
        existing = doc_ref.get()

        if existing.exists:
            logger.info(f"Rule already exists, updating: {collection_path}/{rule_id}")
            doc_ref.set(rule, merge=True)
        else:
            logger.info(f"Creating new rule: {collection_path}/{rule_id}")
            doc_ref.set(rule)

    logger.info("Done seeding student_truth duplicate rules.")


if __name__ == "__main__":
    seed_rules()
