"""Aggregate and score issues prior to writing."""

from __future__ import annotations

import logging
from collections import defaultdict
from typing import Dict, Iterable, List, Set

from ..utils.issues import IssuePayload

logger = logging.getLogger(__name__)


def merge(issues: Iterable[IssuePayload]) -> List[IssuePayload]:
    grouped: Dict[str, IssuePayload] = {}
    seen_keys: Set[str] = set()  # Track all keys to detect duplicates
    duplicates_found = 0
    
    for issue in issues:
        key = f"{issue.rule_id}:{issue.record_id}"
        
        # Check if we've seen this exact combination before
        if key in seen_keys and key not in grouped:
            # This shouldn't happen, but log if it does
            logger.warning(f"Duplicate key detected but not in grouped: {key}")
        
        if key not in grouped:
            grouped[key] = issue
            seen_keys.add(key)
        else:
            duplicates_found += 1
            existing = grouped[key]
            # Merge metadata but keep the first issue's other fields
            existing.metadata.update(issue.metadata)
    
    # Validate no duplicates remain
    final_keys = {f"{issue.rule_id}:{issue.record_id}" for issue in grouped.values()}
    if len(final_keys) != len(grouped):
        logger.error(
            f"Duplicate keys found after merge: {len(grouped)} issues but {len(final_keys)} unique keys",
            extra={"total_issues": len(grouped), "unique_keys": len(final_keys)}
        )
    
    if duplicates_found > 0:
        logger.warning(
            f"Found {duplicates_found} duplicate issues during merge",
            extra={"duplicates_removed": duplicates_found, "total_issues": len(grouped)}
        )
    
    return list(grouped.values())


def summarize(issues: Iterable[IssuePayload]) -> Dict[str, int]:
    counts = defaultdict(int)
    duplicate_group_ids: set = set()
    attendance_by_metric: Dict[str, int] = defaultdict(int)
    
    for issue in issues:
        counts[issue.issue_type] += 1
        counts[f"{issue.issue_type}:{issue.severity}"] += 1
        
        # Track duplicate groups
        if issue.issue_type == "duplicate" and "group_id" in issue.metadata:
            duplicate_group_ids.add(issue.metadata["group_id"])
        
        # Track attendance anomalies by metric
        if issue.issue_type == "attendance" and "metric" in issue.metadata:
            metric_name = issue.metadata["metric"]
            attendance_by_metric[f"attendance:{metric_name}"] += 1
            attendance_by_metric[f"attendance:{metric_name}:{issue.severity}"] += 1
    
    # Add duplicate groups count
    if duplicate_group_ids:
        counts["duplicate_groups_formed"] = len(duplicate_group_ids)
    
    # Add attendance breakdown
    counts.update(attendance_by_metric)
    
    return dict(counts)
