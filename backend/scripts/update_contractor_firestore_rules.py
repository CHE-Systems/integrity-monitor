"""Script to update contractor required field rules in Firestore to use field IDs.

This script updates any existing Firestore rules for contractors to use Airtable field IDs
instead of field names.

Field ID mappings:
- Email: flddCJDACjAsP1ltS
- Cell phone: fldWBnA5Xf6eQATOi
- Contractor/Vol: fldvkUuMlXw8vBvNQ
- Certification: fldUXiLJmTxJ9aeRp
- Approval: fldi9MWrddOg3PUZ7 (replaces onboarding_status)

Removes: EIN rule (field doesn't exist in Airtable)
"""

import logging
from google.cloud import firestore

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Field mappings: old field name -> new field ID
FIELD_MAPPINGS = {
    "email": "flddCJDACjAsP1ltS",
    "onboarding_status": "fldi9MWrddOg3PUZ7",
}

# New rules to add (if they don't exist)
NEW_RULES = [
    {
        "field": "fldWBnA5Xf6eQATOi",
        "severity": "warning",
        "message": "Cell phone is required.",
    },
    {
        "field": "fldvkUuMlXw8vBvNQ",
        "severity": "warning",
        "message": "Contractor/Vol role type is required.",
    },
    {
        "field": "fldUXiLJmTxJ9aeRp",
        "severity": "warning",
        "message": "Certification is required.",
    },
]


def update_contractor_firestore_rules():
    """Update contractor required field rules in Firestore."""
    try:
        db = firestore.Client()
        collection_path = "rules/required_fields/contractors"
        collection_ref = db.collection(collection_path)

        # Get all existing rules
        existing_rules = {}
        for doc in collection_ref.stream():
            rule_data = doc.to_dict()
            field_name = rule_data.get("field")
            if field_name:
                existing_rules[field_name] = (doc.id, rule_data)

        logger.info(f"Found {len(existing_rules)} existing contractor rules in Firestore")

        # Update existing rules with field ID mappings
        updated_count = 0
        removed_count = 0

        for old_field, (doc_id, rule_data) in existing_rules.items():
            if old_field == "ein":
                # Remove EIN rule (field doesn't exist)
                doc_ref = collection_ref.document(doc_id)
                doc_ref.update({"enabled": False})
                logger.info(f"Disabled EIN rule: {doc_id}")
                removed_count += 1
            elif old_field in FIELD_MAPPINGS:
                # Update field name to field ID
                new_field_id = FIELD_MAPPINGS[old_field]
                doc_ref = collection_ref.document(doc_id)
                doc_ref.update({"field": new_field_id})
                logger.info(f"Updated rule {doc_id}: {old_field} -> {new_field_id}")
                updated_count += 1

        # Add new rules if they don't exist
        added_count = 0
        existing_field_ids = {
            rule_data.get("field") for _, rule_data in existing_rules.values()
        }

        for new_rule in NEW_RULES:
            field_id = new_rule["field"]
            if field_id not in existing_field_ids:
                # Generate rule ID from field ID
                rule_id = f"required.contractors.{field_id}"
                new_rule.update({
                    "rule_id": rule_id,
                    "enabled": True,
                    "source": "migration",
                })
                collection_ref.document(rule_id).set(new_rule)
                logger.info(f"Added new rule: {rule_id} for field {field_id}")
                added_count += 1

        logger.info(
            f"Migration complete: {updated_count} updated, {removed_count} removed, "
            f"{added_count} added"
        )

    except Exception as exc:
        logger.error(f"Failed to update Firestore rules: {exc}", exc_info=True)
        raise


if __name__ == "__main__":
    update_contractor_firestore_rules()

