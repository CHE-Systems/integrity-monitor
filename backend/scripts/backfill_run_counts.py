"""Backfill integrity_runs counts.by_type to remove double-counting."""

from __future__ import annotations

import argparse
import logging
import os
import sys
from datetime import datetime, timezone
from typing import Dict, Tuple

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from backend.clients.firestore import FirestoreClient
from backend.config.config_loader import load_runtime_config


logger = logging.getLogger(__name__)

VALID_SEVERITIES = {"critical", "warning", "info"}


def _parse_date(value: str) -> datetime:
    return datetime.strptime(value, "%Y-%m-%d").replace(tzinfo=timezone.utc)


def _rebuild_by_type(counts: Dict) -> Tuple[Dict[str, int], str]:
    """Rebuild by_type from available data.

    Priority:
    1) Use by_type_severity if present (exact).
    2) Fallback to halving existing by_type (best-effort).
    """
    by_type_severity = counts.get("by_type_severity")
    if isinstance(by_type_severity, dict) and by_type_severity:
        rebuilt: Dict[str, int] = {}
        for key, value in by_type_severity.items():
            if not isinstance(value, int):
                continue
            if ":" not in key:
                continue
            issue_type, severity = key.split(":", 1)
            if severity not in VALID_SEVERITIES:
                continue
            rebuilt[issue_type] = rebuilt.get(issue_type, 0) + value
        if rebuilt:
            return rebuilt, "by_type_severity"

    by_type = counts.get("by_type", {})
    if not isinstance(by_type, dict):
        return {}, "missing_by_type"

    rebuilt = {}
    for issue_type, value in by_type.items():
        if not isinstance(value, (int, float)):
            continue
        rebuilt[issue_type] = max(0, int(round(value / 2)))
    return rebuilt, "halved"


def main() -> int:
    parser = argparse.ArgumentParser(description="Backfill integrity_runs counts.by_type.")
    parser.add_argument("--start-date", required=True, help="YYYY-MM-DD (UTC)")
    parser.add_argument("--apply", action="store_true", help="Write changes to Firestore")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    start_dt = _parse_date(args.start_date)
    config = load_runtime_config()
    firestore_client = FirestoreClient(config.firestore)
    db = firestore_client.db
    runs_ref = db.collection(config.firestore.runs_collection)

    query = runs_ref.where("started_at", ">=", start_dt).order_by("started_at")
    runs = list(query.stream())

    logger.info("Found %d runs starting from %s", len(runs), start_dt.date().isoformat())

    updated = 0
    skipped = 0
    for doc in runs:
        data = doc.to_dict()
        counts = data.get("counts") or {}
        if not isinstance(counts, dict) or not counts.get("by_type"):
            skipped += 1
            continue

        rebuilt_by_type, method = _rebuild_by_type(counts)
        if not rebuilt_by_type:
            skipped += 1
            continue

        if rebuilt_by_type == counts.get("by_type"):
            skipped += 1
            continue

        new_counts = dict(counts)
        new_counts["by_type"] = rebuilt_by_type

        if args.apply:
            doc.reference.set({"counts": new_counts}, merge=True)
        updated += 1
        logger.info(
            "Run %s updated (%s).",
            doc.id,
            method,
        )

    logger.info("Done. Updated: %d, Skipped: %d", updated, skipped)
    if not args.apply:
        logger.info("Dry run only. Re-run with --apply to write changes.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
