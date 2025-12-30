"""Attendance anomaly detection per docs/prompt-5-attendance-rules.md."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

from ..config.settings import AttendanceRules, MetricThresholds
from ..utils.issues import IssuePayload
from ..utils.records import get_field

ABSENT_STATUSES = {
    "absent",
    "unexcused absence",
    "excused absence",
    "no show",
    "absence",
}
TARDY_STATUSES = {"tardy", "late"}


@dataclass
class AttendanceEntry:
    record_id: str
    student_id: str
    class_id: Optional[str]
    date: date
    status: str
    minutes_attended: Optional[float]
    minutes_scheduled: Optional[float]

    @property
    def is_absent(self) -> bool:
        return self.status in ABSENT_STATUSES

    @property
    def is_tardy(self) -> bool:
        return self.status in TARDY_STATUSES

    @property
    def is_present(self) -> bool:
        return not self.is_absent


@dataclass
class AbsentEntry:
    """Represents a record from the Absent table."""
    record_id: str
    student_id: str
    date: date
    created_time: Optional[datetime] = None  # For sorting duplicates


@dataclass
class StudentInfo:
    record_id: str
    enrollment_start: Optional[date]
    classes_per_week: Optional[float]


def _detect_duplicate_absences(absent_records: List[dict]) -> List[IssuePayload]:
    """Detect duplicate absence records for the same student on the same day.
    
    Groups Absent records by (student_id, date) and flags all but the first
    record as duplicates. The first record is determined by record_id (lexicographic)
    or created_time if available.
    
    Args:
        absent_records: List of Airtable record dicts from Absent table
        
    Returns:
        List of IssuePayload for duplicate absence records
    """
    if not absent_records:
        return []
    
    # Normalize Absent records
    absent_entries = _normalize_absent(absent_records)
    if not absent_entries:
        return []
    
    # Group by (student_id, date)
    grouped: Dict[Tuple[str, date], List[AbsentEntry]] = defaultdict(list)
    for entry in absent_entries:
        key = (entry.student_id, entry.date)
        grouped[key].append(entry)
    
    issues: List[IssuePayload] = []
    
    # Process each group
    for (student_id, absent_date), entries in grouped.items():
        if len(entries) <= 1:
            continue  # No duplicates
        
        # Sort entries to determine which one to keep as primary
        # Prefer created_time if available, otherwise use record_id
        # Use a far future date for entries without created_time to sort them last
        max_date = datetime(9999, 12, 31)
        entries_sorted = sorted(
            entries,
            key=lambda e: (
                e.created_time if e.created_time else max_date,
                e.record_id
            )
        )
        
        # Keep the first entry as primary, flag the rest as duplicates
        primary_entry = entries_sorted[0]
        duplicate_entries = entries_sorted[1:]
        
        for duplicate_entry in duplicate_entries:
            issues.append(
                IssuePayload(
                    rule_id="attendance.duplicate_absence",
                    issue_type="attendance",
                    entity="absent",
                    record_id=duplicate_entry.record_id,
                    severity="warning",
                    description=(
                        f"Duplicate absence record for student on {absent_date.strftime('%Y-%m-%d')}. "
                        f"Found {len(entries)} absence records for the same student on this date. "
                        f"Primary record: {primary_entry.record_id}"
                    ),
                    metadata={
                        "student_id": student_id,
                        "date": absent_date.isoformat(),
                        "duplicate_count": len(entries),
                        "primary_record_id": primary_entry.record_id,
                    },
                )
            )
    
    return issues


def run(records: Dict[str, list], attendance_rules: AttendanceRules) -> List[IssuePayload]:
    """Run attendance anomaly checks.
    
    Primary check: Detect duplicate absence records (same student + same date)
    Secondary check: Pattern-based anomaly detection (rates, consecutive absences, etc.)
    
    Args:
        records: Dict mapping entity names to lists of Airtable records
        attendance_rules: AttendanceRules configuration
        
    Returns:
        List of IssuePayload for all detected issues
    """
    issues: List[IssuePayload] = []
    
    # PRIMARY CHECK: Detect duplicate absences from Absent table
    absent_records = records.get("absent", [])
    if absent_records:
        duplicate_issues = _detect_duplicate_absences(absent_records)
        issues.extend(duplicate_issues)
    
    # SECONDARY CHECK: Pattern-based anomaly detection from Attendance table
    attendance_entries = _normalize_attendance(records.get("attendance", []))
    if attendance_entries:
        students = _index_students(records.get("students", []))
        grouped = defaultdict(list)
        for entry in attendance_entries:
            grouped[entry.student_id].append(entry)
        
        for student_id, entries in grouped.items():
            student_info = students.get(student_id)
            metrics = _calculate_metrics(entries, student_info, attendance_rules)
            for metric_name, value in metrics.items():
                severity, threshold = _classify(metric_name, value, attendance_rules.thresholds.get(metric_name))
                if severity:
                    issues.append(
                        IssuePayload(
                            rule_id=f"attendance.{metric_name}",
                            issue_type="attendance",
                            entity="student",
                            record_id=student_id,
                            severity=severity,
                            description=_build_description(metric_name, value, threshold),
                            metadata={
                                "metric": metric_name,
                                "observed": value,
                                "threshold": threshold,
                                "student_id": student_id,
                            },
                        )
                    )
    
    return issues


def _normalize_absent(records: Iterable[dict]) -> List[AbsentEntry]:
    """Normalize Absent table records to AbsentEntry objects.
    
    Args:
        records: Iterable of Airtable record dicts from Absent table
        
    Returns:
        List of AbsentEntry objects with student_id, date, and record_id
    """
    entries: List[AbsentEntry] = []
    for record in records:
        record_id = record.get("id")
        if not record_id:
            continue
        fields = record.get("fields", {})
        
        # Extract student link
        student_links = fields.get("Student") or fields.get("student")
        if isinstance(student_links, list):
            student_id = student_links[0] if student_links else None
        else:
            student_id = student_links or fields.get("student_id")
        if not student_id:
            continue
        
        # Extract date
        date_value = fields.get("Date") or fields.get("date")
        parsed_date = _parse_date(date_value)
        if not parsed_date:
            continue
        
        # Extract created time for sorting (optional)
        created_time = None
        created_time_str = record.get("createdTime")
        if created_time_str:
            try:
                if isinstance(created_time_str, str):
                    # Airtable createdTime is ISO format: "2024-01-15T10:30:00.000Z"
                    # Try parsing with datetime.strptime first
                    try:
                        # Remove timezone info if present (Z or +HH:MM)
                        clean_str = created_time_str.replace('Z', '+00:00')
                        if '+' in clean_str or clean_str.count('-') > 2:
                            # Has timezone
                            if '+' in clean_str:
                                dt_str, tz_str = clean_str.rsplit('+', 1)
                                created_time = datetime.strptime(dt_str, "%Y-%m-%dT%H:%M:%S.%f")
                            elif clean_str.endswith('+00:00'):
                                dt_str = clean_str.replace('+00:00', '')
                                created_time = datetime.strptime(dt_str.rstrip('Z'), "%Y-%m-%dT%H:%M:%S.%f")
                        else:
                            created_time = datetime.strptime(clean_str, "%Y-%m-%dT%H:%M:%S.%f")
                    except ValueError:
                        # Try without microseconds
                        try:
                            clean_str = created_time_str.replace('Z', '').split('.')[0]
                            created_time = datetime.strptime(clean_str, "%Y-%m-%dT%H:%M:%S")
                        except ValueError:
                            pass
                elif isinstance(created_time_str, datetime):
                    created_time = created_time_str
            except Exception:
                pass
        
        entries.append(
            AbsentEntry(
                record_id=record_id,
                student_id=student_id,
                date=parsed_date,
                created_time=created_time,
            )
        )
    return entries


def _normalize_attendance(records: Iterable[dict]) -> List[AttendanceEntry]:
    entries: List[AttendanceEntry] = []
    for record in records:
        record_id = record.get("id")
        fields = record.get("fields", {})
        student_links = fields.get("Student")
        if isinstance(student_links, list):
            student_id = student_links[0] if student_links else None
        else:
            student_id = student_links or fields.get("student_id")
        if not student_id:
            continue
        class_links = fields.get("Class") or fields.get("class_id")
        class_id = None
        if isinstance(class_links, list):
            class_id = class_links[0] if class_links else None
        elif isinstance(class_links, str):
            class_id = class_links
        date_value = fields.get("Date") or fields.get("date")
        parsed_date = _parse_date(date_value)
        if not parsed_date:
            continue
        status_raw = str(fields.get("Status") or fields.get("status") or "").strip().lower()
        minutes_attended = _to_float(fields.get("Minutes Attended") or fields.get("minutes_attended"))
        minutes_scheduled = _to_float(fields.get("Scheduled Minutes") or fields.get("minutes_scheduled"))
        entries.append(
            AttendanceEntry(
                record_id=record_id,
                student_id=student_id,
                class_id=class_id,
                date=parsed_date,
                status=status_raw or "unknown",
                minutes_attended=minutes_attended,
                minutes_scheduled=minutes_scheduled,
            )
        )
    return entries


def _index_students(records: Iterable[dict]) -> Dict[str, StudentInfo]:
    indexed: Dict[str, StudentInfo] = {}
    for record in records:
        record_id = record.get("id")
        fields = record.get("fields", {})
        enrollment_start = _parse_date(
            get_field(fields, "enrollment_start") or get_field(fields, "Enrollment Date")
        )
        classes_per_week = _to_float(get_field(fields, "classes_per_week") or get_field(fields, "Classes Per Week"))
        indexed[record_id] = StudentInfo(
            record_id=record_id,
            enrollment_start=enrollment_start,
            classes_per_week=classes_per_week,
        )
    return indexed


def _calculate_metrics(
    entries: List[AttendanceEntry],
    student_info: Optional[StudentInfo],
    rules: AttendanceRules,
) -> Dict[str, float]:
    if not entries:
        return {}
    entries = sorted(entries, key=lambda e: e.date)
    anchor_date = entries[-1].date
    grace_cutoff = None
    if student_info and student_info.enrollment_start:
        grace_cutoff = student_info.enrollment_start + timedelta(days=rules.onboarding_grace_days)
    filtered_entries = [
        entry for entry in entries if not grace_cutoff or entry.date >= grace_cutoff
    ]
    if not filtered_entries:
        return {}

    metrics: Dict[str, float] = {}
    metrics["absence_rate_30d"] = _absence_rate(filtered_entries, anchor_date, 30)
    metrics["absences_4w"] = _count_absences(filtered_entries, anchor_date, 28)
    metrics["absence_rate_term"] = _absence_rate(filtered_entries, anchor_date, None)
    metrics["consecutive_absences"] = _max_consecutive(filtered_entries)
    metrics["consecutive_weeks_absences"] = _consecutive_weeks_with_absences(filtered_entries)
    metrics["tardy_rate"] = _tardy_rate(filtered_entries)
    metrics["partial_attendance"] = _partial_count(filtered_entries, anchor_date, 30)

    # Adjust for limited schedules by scaling to small denominators.
    if student_info and student_info.classes_per_week:
        if student_info.classes_per_week < rules.limited_schedule_threshold:
            total_sessions = len(filtered_entries)
            if total_sessions:
                metrics["absence_rate_30d"] = metrics["absences_4w"] / max(total_sessions, 1)
                metrics["absence_rate_term"] = _count_absences(filtered_entries, anchor_date, None) / total_sessions
    return metrics


def _absence_rate(entries: List[AttendanceEntry], anchor: date, window_days: Optional[int]) -> float:
    window_entries = _window_entries(entries, anchor, window_days)
    total = len(window_entries)
    if total == 0:
        return 0.0
    absent = sum(1 for entry in window_entries if entry.is_absent)
    return absent / total


def _count_absences(entries: List[AttendanceEntry], anchor: date, window_days: Optional[int]) -> float:
    window_entries = _window_entries(entries, anchor, window_days)
    return float(sum(1 for entry in window_entries if entry.is_absent))


def _max_consecutive(entries: List[AttendanceEntry]) -> float:
    streak = 0
    per_class: Dict[str, List[date]] = defaultdict(list)
    for entry in entries:
        if entry.class_id and entry.is_absent:
            per_class[entry.class_id].append(entry.date)
    for class_dates in per_class.values():
        class_dates = sorted(set(class_dates))
        current = 1 if class_dates else 0
        best = current
        for i in range(1, len(class_dates)):
            if (class_dates[i] - class_dates[i - 1]).days <= 7:
                current += 1
            else:
                current = 1
            best = max(best, current)
        streak = max(streak, best)
    return float(streak)


def _consecutive_weeks_with_absences(entries: List[AttendanceEntry]) -> float:
    """Calculate the longest streak of consecutive weeks with at least one absence.
    
    Groups entries by calendar week (ISO week, Monday-Sunday) and tracks
    consecutive weeks where each week has at least one absent entry.
    
    Returns:
        Count of consecutive weeks with absences (0 if none)
    """
    if not entries:
        return 0.0
    
    # Group entries by week (ISO week number and year)
    weeks_with_absences: Set[Tuple[int, int]] = set()
    
    for entry in entries:
        if entry.is_absent:
            # Get ISO week number and year
            iso_year, iso_week, _ = entry.date.isocalendar()
            weeks_with_absences.add((iso_year, iso_week))
    
    if not weeks_with_absences:
        return 0.0
    
    # Sort weeks chronologically
    sorted_weeks = sorted(weeks_with_absences)
    
    # Find longest consecutive streak
    if len(sorted_weeks) == 1:
        return 1.0
    
    max_streak = 1
    current_streak = 1
    
    for i in range(1, len(sorted_weeks)):
        prev_year, prev_week = sorted_weeks[i - 1]
        curr_year, curr_week = sorted_weeks[i]
        
        # Calculate if weeks are consecutive
        # Handle year boundary (week 52/53 -> week 1 of next year)
        if curr_year == prev_year:
            if curr_week == prev_week + 1:
                current_streak += 1
            else:
                current_streak = 1
        elif curr_year == prev_year + 1:
            # Check if prev_week is last week of year and curr_week is first week
            # ISO weeks can be 52 or 53, so we check if prev_week >= 52
            if prev_week >= 52 and curr_week == 1:
                current_streak += 1
            else:
                current_streak = 1
        else:
            current_streak = 1
        
        max_streak = max(max_streak, current_streak)
    
    return float(max_streak)


def _tardy_rate(entries: List[AttendanceEntry]) -> float:
    total = len(entries)
    if total == 0:
        return 0.0
    tardy = sum(1 for entry in entries if entry.is_tardy)
    return tardy / total


def _partial_count(entries: List[AttendanceEntry], anchor: date, window_days: Optional[int]) -> float:
    window_entries = _window_entries(entries, anchor, window_days)
    count = 0
    for entry in window_entries:
        if entry.minutes_attended is None or entry.minutes_scheduled is None:
            continue
        if entry.minutes_scheduled <= 0:
            continue
        ratio = entry.minutes_attended / entry.minutes_scheduled
        if ratio < 0.5:
            count += 1
    return float(count)


def _window_entries(entries: List[AttendanceEntry], anchor: date, window_days: Optional[int]) -> List[AttendanceEntry]:
    if window_days is None:
        return entries
    return [entry for entry in entries if 0 <= (anchor - entry.date).days < window_days]


def _classify(metric: str, value: float, thresholds: Optional[MetricThresholds]) -> Tuple[Optional[str], Optional[float]]:
    if thresholds is None:
        return None, None
    if thresholds.critical is not None and value >= thresholds.critical:
        return "critical", thresholds.critical
    if thresholds.warning is not None and value >= thresholds.warning:
        return "warning", thresholds.warning
    if thresholds.info is not None and value >= thresholds.info:
        return "info", thresholds.info
    return None, None


def _build_description(metric: str, value: float, threshold: Optional[float]) -> str:
    value_str = f"{value:.2f}" if isinstance(value, float) else str(value)
    if threshold is None:
        return f"{metric} observed value {value_str}."
    return f"{metric.replace('_', ' ').title()} is {value_str} (threshold {threshold})."


def _parse_date(value: Any) -> Optional[date]:
    if isinstance(value, date):
        return value
    if isinstance(value, datetime):
        return value.date()
    if not value:
        return None
    for fmt in ("%Y-%m-%d", "%m/%d/%Y"):
        try:
            return datetime.strptime(str(value), fmt).date()
        except ValueError:
            continue
    return None


def _to_float(value: Any) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None
