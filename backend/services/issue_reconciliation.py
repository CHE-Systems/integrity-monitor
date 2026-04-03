"""Reconcile open Firestore issues against scan output.

After a successful scan, any open issue whose stable doc ID was NOT produced
by the current run (within the run's entity + issue-type scope) is
soft-resolved with status ``auto_resolved``.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set

from ..clients.firestore import FirestoreClient
from ..utils.issues import IssuePayload

logger = logging.getLogger(__name__)

CHECK_TO_ISSUE_TYPES: Dict[str, List[str]] = {
    "duplicates": ["duplicate"],
    "links": [
        "orphaned_link",
        "missing_link",
        "excessive_link",
        "inactive_link",
        "missing_reverse_link",
        "cross_entity_mismatch",
    ],
    "required_fields": ["missing_field"],
    "value_checks": ["value_present"],
    "attendance": ["attendance"],
}


def issue_types_from_checks(checks_executed: List[str]) -> Set[str]:
    """Derive the set of issue_type values covered by executed checks."""
    types: Set[str] = set()
    for check in checks_executed:
        types.update(CHECK_TO_ISSUE_TYPES.get(check, []))
    return types


def reconcile_open_issues(
    firestore_client: FirestoreClient,
    run_id: str,
    merged: List[IssuePayload],
    entities_included: List[str],
    checks_executed: List[str],
    log_callback: Optional[Any] = None,
) -> int:
    """Auto-resolve open issues not present in the current scan output.

    Args:
        firestore_client: Firestore client with access to issues collection.
        run_id: Current scan run ID.
        merged: Deduplicated issue payloads produced by this run.
        entities_included: Entities that were scanned in this run.
        checks_executed: Check names that actually ran (e.g. "duplicates").
        log_callback: Optional ``(level, message)`` callable for run logs.

    Returns:
        Number of issues auto-resolved.
    """

    def _log(level: str, msg: str) -> None:
        if log_callback:
            try:
                log_callback(level, msg)
            except Exception:
                pass
        getattr(logger, level, logger.info)(msg, extra={"run_id": run_id})

    issue_types_covered = issue_types_from_checks(checks_executed)
    if not issue_types_covered:
        _log("info", "Reconciliation skipped: no issue types in scope")
        return 0
    if not entities_included:
        _log("info", "Reconciliation skipped: no entities in scope")
        return 0

    # Build set of doc IDs the scan produced
    seen_ids: Set[str] = set()
    for payload in merged:
        doc_id = firestore_client._generate_doc_id(
            {"rule_id": payload.rule_id, "record_id": payload.record_id}
        )
        seen_ids.add(doc_id)

    _log("info", f"Reconciliation: {len(seen_ids)} seen IDs, scope={len(entities_included)} entities, types={sorted(issue_types_covered)}")

    client = firestore_client._get_client()
    collection_ref = client.collection(firestore_client._config.issues_collection)

    candidates_checked = 0
    auto_resolved = 0
    batch = client.batch()
    batch_count = 0
    now = datetime.now(timezone.utc)

    for entity in entities_included:
        try:
            q = (
                collection_ref
                .where("status", "==", "open")
                .where("entity", "==", entity)
            )
            for doc in q.stream():
                candidates_checked += 1
                doc_data = doc.to_dict()

                doc_issue_type = doc_data.get("issue_type", "")
                if doc_issue_type not in issue_types_covered:
                    continue

                if doc_data.get("status") == "ignored":
                    continue

                if doc.id in seen_ids:
                    continue

                batch.update(doc.reference, {
                    "status": "auto_resolved",
                    "resolved_at": now,
                    "resolved_by": "scan",
                    "cleared_in_run_id": run_id,
                    "updated_at": now,
                })
                batch_count += 1
                auto_resolved += 1

                if batch_count >= 500:
                    firestore_client._commit_batch_with_retry(batch, batch_count)
                    batch = client.batch()
                    batch_count = 0

        except Exception as exc:
            _log("warning", f"Reconciliation query failed for entity '{entity}': {exc}")
            continue

    if batch_count > 0:
        try:
            firestore_client._commit_batch_with_retry(batch, batch_count)
        except Exception as exc:
            _log("warning", f"Reconciliation final batch commit failed: {exc}")

    _log(
        "info",
        f"Reconciliation complete: checked {candidates_checked} open issues, "
        f"auto-resolved {auto_resolved}",
    )
    return auto_resolved
