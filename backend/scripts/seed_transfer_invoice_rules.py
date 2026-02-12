"""Seed required field rules for Transfers and Contractor/Vendor Invoices tables.

Transfers rules:
  1. Sender (fldh0r42ghMvDOd4B) - required
  2. Recipient - any of the year-specific recipient fields must be populated
     - Recipient 2025-2026 (fldd1mvuCqvaXUD4f)
     - Recipient 2024-2025 (fldVpRA2wxoL25Uty)
  3. Amount (fldQfFuw2ekUPyWD7) - required

Contractor/Vendor Invoices rules:
  1. Micro-Campus Data (fldh7BIJzBKiHTpjq) - required
  2. Provider - either "Enrichment Service Providers" (fld9sQipaKxoIE3yq) or "Contractor" (fld6Wy1XScx8joLFh)
  3. Entered Amount (fldbfbKf2sxASH4ye) - required

Usage:
  python -m backend.scripts.seed_transfer_invoice_rules
"""

import logging
from google.cloud import firestore

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


TRANSFER_RULES = [
    {
        "rule_id": "required.transfers.sender",
        "field": "Sender",
        "field_id": "fldh0r42ghMvDOd4B",
        "message": "Transfer is missing a Sender.",
        "severity": "critical",
        "enabled": True,
    },
    {
        "rule_id": "required.transfers.recipient",
        "field": "Recipient 2025-2026",
        "field_id": "fldd1mvuCqvaXUD4f",
        "alternate_fields": ["Recipient 2024-2025"],
        "message": "Transfer is missing a Recipient (no recipient found for any school year).",
        "severity": "critical",
        "enabled": True,
    },
    {
        "rule_id": "required.transfers.amount",
        "field": "Amount",
        "field_id": "fldQfFuw2ekUPyWD7",
        "message": "Transfer is missing an Amount.",
        "severity": "critical",
        "enabled": True,
    },
]

INVOICE_RULES = [
    {
        "rule_id": "required.invoices.micro_campus_data",
        "field": "Micro-Campus Data",
        "field_id": "fldh7BIJzBKiHTpjq",
        "message": "Invoice is missing Micro-Campus Data.",
        "severity": "critical",
        "enabled": True,
    },
    {
        "rule_id": "required.invoices.provider",
        "field": "Enrichment Service Providers",
        "field_id": "fld9sQipaKxoIE3yq",
        "alternate_fields": ["Contractor"],
        "message": "Invoice is missing a provider (neither Enrichment Service Providers nor Contractor is set).",
        "severity": "critical",
        "enabled": True,
    },
    {
        "rule_id": "required.invoices.entered_amount",
        "field": "Entered Amount",
        "field_id": "fldbfbKf2sxASH4ye",
        "message": "Invoice is missing an Entered Amount.",
        "severity": "critical",
        "enabled": True,
    },
]


def seed_rules():
    """Seed required field rules for transfers and invoices in Firestore."""
    db = firestore.Client()

    for entity, rules in [("transfers", TRANSFER_RULES), ("invoices", INVOICE_RULES)]:
        collection_path = f"rules/required_fields/{entity}"
        collection_ref = db.collection(collection_path)

        for rule in rules:
            rule_id = rule["rule_id"]
            doc_ref = collection_ref.document(rule_id)
            existing = doc_ref.get()

            if existing.exists:
                logger.info(f"Rule already exists, updating: {collection_path}/{rule_id}")
                doc_ref.set(rule, merge=True)
            else:
                logger.info(f"Creating new rule: {collection_path}/{rule_id}")
                doc_ref.set(rule)

    logger.info("Done seeding transfer and invoice rules.")


if __name__ == "__main__":
    seed_rules()
