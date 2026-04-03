#!/usr/bin/env python3
"""Ensure dup.student.phone_name rule exists and requires first + last name similarity.

Creates the rule if missing, updates it if it exists with the old conditions.

The rule requires ALL of:
  - Phone exact match
  - First name similarity >= 0.85 (catches John/Jon, not John/Jane)
  - Last name similarity >= 0.92

This prevents siblings (same phone, same last name, different first names) from
being flagged as duplicates.

Usage:
  source backend/.venv/bin/activate
  python3 -m backend.scripts.update_student_phone_name_duplicate_rule
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from google.cloud import firestore
from dotenv import load_dotenv


RULE_ID = "dup.student.phone_name"
COLLECTION_PATH = "rules/duplicates/students"

RULE_DOC = {
    "rule_id": RULE_ID,
    "entity": "students",
    "severity": "likely",
    "enabled": True,
    "description": (
        "Phone exact match and first name + last name similarity (both required). "
        "Prevents siblings from being flagged (same phone, same last name, different first names)."
    ),
    "conditions": [
        {"type": "exact_match", "field": "primary_phone"},
        {"type": "similarity", "field": "legal_first_name", "similarity": 0.85},
        {"type": "similarity", "field": "legal_last_name", "similarity": 0.92},
    ],
}


def run():
    # Ensure project-scoped env vars are loaded for standalone script runs.
    backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    load_dotenv(os.path.join(backend_dir, ".env"))

    db = firestore.Client()
    doc_ref = db.collection(COLLECTION_PATH).document(RULE_ID)
    existing = doc_ref.get()

    if existing.exists:
        data = existing.to_dict()
        conditions = data.get("conditions", [])
        has_first_name = any(
            c.get("field") == "legal_first_name" and c.get("type") == "similarity"
            for c in conditions
        )
        if has_first_name:
            print(f"Rule already up to date at {COLLECTION_PATH}/{RULE_ID}")
            return

        print(f"Updating existing rule at {COLLECTION_PATH}/{RULE_ID}")
        doc_ref.set(RULE_DOC)
        print("Done — updated conditions to require first + last name similarity.")
    else:
        print(f"Rule not found — creating {COLLECTION_PATH}/{RULE_ID}")
        doc_ref.set(RULE_DOC)
        print("Done — created new rule.")


if __name__ == "__main__":
    run()
