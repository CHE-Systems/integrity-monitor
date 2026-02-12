"""Duplicate detection logic based on docs/prompt-3-duplicate-spec.md."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, datetime
from itertools import combinations
import uuid
from typing import Any, Callable, Dict, Iterable, List, Optional, Set, Tuple
from collections import defaultdict

from ..config.models import DuplicateDefinition, DuplicateRule, SchemaConfig
from ..utils.issues import IssuePayload
from ..utils.normalization import normalize_name, normalize_phone
from ..utils.similarity import jaccard_ratio, jaro_winkler
from .duplicate_conditions import evaluate_condition

logger = logging.getLogger(__name__)

LIKELY_THRESHOLD = 0.8
POSSIBLE_THRESHOLD = 0.6
LIKELY_SEVERITY = "warning"
POSSIBLE_SEVERITY = "info"


def _serialize_for_firestore(obj: Any) -> Any:
    """Recursively convert non-Firestore-safe types (date, datetime) to strings."""
    if isinstance(obj, datetime):
        return obj.isoformat()
    if isinstance(obj, date):
        return obj.isoformat()
    if isinstance(obj, dict):
        return {k: _serialize_for_firestore(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_serialize_for_firestore(item) for item in obj]
    if isinstance(obj, set):
        return [_serialize_for_firestore(item) for item in sorted(obj)]
    return obj


@dataclass
class StudentRecord:
    record_id: str
    name: str
    normalized_name: str
    last_name_norm: str
    last_name_soundex: str
    campus: str
    grade: str
    parents: Set[str]
    truth_id: str
    dob: Optional[date]
    email: str
    email_local: str
    email_domain: str
    phone: str
    normalized_phone: str


@dataclass
class ParentRecord:
    record_id: str
    name: str
    normalized_name: str
    last_name_soundex: str
    students: Set[str]
    email: str
    normalized_email: str
    phone: str
    normalized_phone: str
    address_zip: str


@dataclass
class ContractorRecord:
    record_id: str
    name: str
    normalized_name: str
    name_soundex: str
    email: str
    normalized_email: str
    phone: str
    normalized_phone: str
    campuses: Set[str]
    ein: str


@dataclass
class PairMatch:
    entity: str
    primary_id: str
    secondary_id: str
    rule_id: str
    match_type: str
    severity: str
    confidence: float
    evidence: Dict[str, Any]


def run(
    records: Dict[str, list], 
    schema_config: Optional[SchemaConfig] = None,
    run_id: Optional[str] = None,
    firestore_writer = None
) -> List[IssuePayload]:
    """Run duplicate detection checks."""
    print(f"[DUP-CHECK] duplicates.run() called - records keys: {list(records.keys())}, student count: {len(records.get('students', []))}", flush=True)
    issues: List[IssuePayload] = []
    
    def console_log(level: str, message: str):
        """Helper to log to both logger and browser console"""
        if level == "info":
            logger.info(message)
        elif level == "warning":
            logger.warning(message)
        elif level == "error":
            logger.error(message)
        
        if run_id and firestore_writer:
            try:
                firestore_writer.write_log(run_id, level, f"[DUPLICATES] {message}")
            except Exception:
                pass  # Don't fail if logging fails
    
    dup_config = schema_config.duplicates if schema_config else {}
    
    # Log what we received
    console_log("info", f"Starting duplicates check - has_schema_config: {schema_config is not None}, dup_config_keys: {list(dup_config.keys()) if dup_config else []}")
    logger.info(
        "Duplicates check: starting",
        extra={
            "has_schema_config": schema_config is not None,
            "dup_config_keys": list(dup_config.keys()) if dup_config else [],
            "dup_config_type": type(dup_config).__name__,
        }
    )
    
    # Log rule counts per entity
    entity_rule_counts = {}
    for entity, dup_def in dup_config.items():
        likely_count = len(dup_def.likely) if dup_def and dup_def.likely else 0
        possible_count = len(dup_def.possible) if dup_def and dup_def.possible else 0
        if likely_count > 0 or possible_count > 0:
            likely_rule_ids = [r.rule_id for r in dup_def.likely] if dup_def and dup_def.likely else []
            possible_rule_ids = [r.rule_id for r in dup_def.possible] if dup_def and dup_def.possible else []
            entity_rule_counts[entity] = {
                "likely": likely_count,
                "possible": possible_count,
                "likely_rule_ids": likely_rule_ids,
                "possible_rule_ids": possible_rule_ids,
            }
    
    if entity_rule_counts:
        logger.info(
            "Duplicates check: processing entities",
            extra={
                "category": "duplicates",
                "entity_rule_counts": entity_rule_counts,
                "total_entities": len(entity_rule_counts),
            }
        )
    else:
        logger.info("Duplicates check: no duplicate rules configured")
    
    # Track all rules and their issue counts
    all_rule_issues = {}
    
    # Get rule IDs for each entity before processing
    student_dup_def = dup_config.get("students")
    student_rule_ids = []
    if student_dup_def:
        student_rule_ids.extend([r.rule_id for r in (student_dup_def.likely or [])])
        student_rule_ids.extend([r.rule_id for r in (student_dup_def.possible or [])])
        all_rule_issues.update({rule_id: 0 for rule_id in student_rule_ids})
    
    parent_dup_def = dup_config.get("parents")
    parent_rule_ids = []
    if parent_dup_def:
        parent_rule_ids.extend([r.rule_id for r in (parent_dup_def.likely or [])])
        parent_rule_ids.extend([r.rule_id for r in (parent_dup_def.possible or [])])
        all_rule_issues.update({rule_id: 0 for rule_id in parent_rule_ids})
    
    contractor_dup_def = dup_config.get("contractors")
    console_log("info", f"Checking contractor duplicate rules - dup_def_is_none: {contractor_dup_def is None}, dup_config_has_contractors: {'contractors' in dup_config}")
    logger.info(
        "Checking contractor duplicate rules",
        extra={
            "contractor_dup_def_is_none": contractor_dup_def is None,
            "contractor_dup_def_type": type(contractor_dup_def).__name__ if contractor_dup_def else None,
            "dup_config_has_contractors": "contractors" in dup_config,
        }
    )
    contractor_rule_ids = []
    if contractor_dup_def:
        likely_list = contractor_dup_def.likely or []
        possible_list = contractor_dup_def.possible or []
        contractor_rule_ids.extend([r.rule_id for r in likely_list])
        contractor_rule_ids.extend([r.rule_id for r in possible_list])
        all_rule_issues.update({rule_id: 0 for rule_id in contractor_rule_ids})
        console_log("info", f"Contractor duplicate rules loaded - likely: {len(likely_list)}, possible: {len(possible_list)}, rule_ids: {contractor_rule_ids}")
        logger.info(
            f"Contractor duplicate rules loaded",
            extra={
                "likely_count": len(likely_list),
                "possible_count": len(possible_list),
                "rule_ids": contractor_rule_ids,
                "likely_rule_ids": [r.rule_id for r in likely_list],
                "possible_rule_ids": [r.rule_id for r in possible_list],
            }
        )
    else:
        console_log("warning", "No contractor duplicate rules found in schema config - dup_def is None or missing")
        logger.warning("No contractor duplicate rules found in schema config - dup_def is None or missing")
    
    student_issues = _process_students(records.get("students", []), student_dup_def, run_id=run_id, firestore_writer=firestore_writer)
    issues.extend(student_issues)
    # Count issues by rule_id
    for issue in student_issues:
        if issue.rule_id in all_rule_issues:
            all_rule_issues[issue.rule_id] += 1
    # Always log, even if 0 issues
    logger.info(
        "Duplicates check: students completed",
        extra={
            "category": "duplicates",
            "entity": "students",
            "issues_found": len(student_issues),
            "rule_issues": {rid: all_rule_issues.get(rid, 0) for rid in student_rule_ids} if student_rule_ids else {},
        }
    )
    
    parent_issues = _process_parents(records.get("parents", []), parent_dup_def)
    issues.extend(parent_issues)
    for issue in parent_issues:
        if issue.rule_id in all_rule_issues:
            all_rule_issues[issue.rule_id] += 1
    logger.info(
        "Duplicates check: parents completed",
        extra={
            "category": "duplicates",
            "entity": "parents",
            "issues_found": len(parent_issues),
            "rule_issues": {rid: all_rule_issues.get(rid, 0) for rid in parent_rule_ids} if parent_rule_ids else {},
        }
    )
    
    contractor_records = records.get("contractors", [])
    likely_count = len(contractor_dup_def.likely) if contractor_dup_def and contractor_dup_def.likely else 0
    possible_count = len(contractor_dup_def.possible) if contractor_dup_def and contractor_dup_def.possible else 0
    console_log("info", f"Processing contractors - records: {len(contractor_records)}, dup_def_is_none: {contractor_dup_def is None}, likely: {likely_count}, possible: {possible_count}")
    logger.info(
        "Processing contractors for duplicates",
        extra={
            "record_count": len(contractor_records),
            "contractor_dup_def_is_none": contractor_dup_def is None,
            "contractor_dup_def_type": type(contractor_dup_def).__name__ if contractor_dup_def else None,
            "has_likely": contractor_dup_def.likely is not None if contractor_dup_def else False,
            "has_possible": contractor_dup_def.possible is not None if contractor_dup_def else False,
            "likely_count": likely_count,
            "possible_count": possible_count,
        }
    )
    contractor_issues = _process_contractors(contractor_records, contractor_dup_def, run_id=run_id, firestore_writer=firestore_writer)
    issues.extend(contractor_issues)
    for issue in contractor_issues:
        if issue.rule_id in all_rule_issues:
            all_rule_issues[issue.rule_id] += 1
    logger.info(
        "Duplicates check: contractors completed",
        extra={
            "category": "duplicates",
            "entity": "contractors",
            "issues_found": len(contractor_issues),
            "rule_issues": {rid: all_rule_issues.get(rid, 0) for rid in contractor_rule_ids} if contractor_rule_ids else {},
        }
    )
    
    logger.info(
        "Duplicates check: completed",
        extra={
            "category": "duplicates",
            "total_issues": len(issues),
        }
    )
    
    return issues


# ---------------------------------------------------------------------------
# Normalization helpers
# ---------------------------------------------------------------------------


def _extract_field(fields: Dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in fields:
            return fields[key]
        title_key = key.replace("_", " ").title()
        if title_key in fields:
            return fields[title_key]
    return None


def _parse_dob(value: Any) -> Optional[date]:
    if not value:
        return None
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    if isinstance(value, datetime):
        return value.date()
    str_value = str(value).strip()
    if not str_value:
        return None
    # Try common date formats including ISO with time component
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(str_value, fmt).date()
        except ValueError:
            continue
    # Try dateutil as last resort for unusual formats
    try:
        from dateutil import parser as dateutil_parser
        return dateutil_parser.parse(str_value).date()
    except Exception:
        pass
    return None


def _soundex(value: str) -> str:
    """Standard Soundex algorithm for phonetic matching.

    Rules:
    1. Keep first letter
    2. Remove H, W (they don't separate same sounds)
    3. Encode remaining letters: BFPV→1, CGJKQSXZ→2, DT→3, L→4, MN→5, R→6
    4. Remove consecutive duplicates
    5. Remove vowels (A, E, I, O, U) and Y
    6. Pad with zeros to length 4
    """
    value = (value or "").upper()
    if not value or not value[0].isalpha():
        return "0000"

    # Soundex code mapping
    codes = {
        "B": "1", "F": "1", "P": "1", "V": "1",
        "C": "2", "G": "2", "J": "2", "K": "2", "Q": "2", "S": "2", "X": "2", "Z": "2",
        "D": "3", "T": "3",
        "L": "4",
        "M": "5", "N": "5",
        "R": "6",
    }

    # Keep first letter
    result = value[0]
    prev_code = codes.get(value[0], "")

    # Process remaining characters
    for char in value[1:]:
        # Skip H, W, vowels (A, E, I, O, U, Y) - they don't encode
        if char in "AEIOUHWY":
            prev_code = ""  # Reset to allow same sound after vowel
            continue

        code = codes.get(char, "")
        if code and code != prev_code:
            result += code
            if len(result) == 4:
                break
        prev_code = code

    # Pad with zeros to length 4
    return (result + "000")[:4]


def _normalize_email(email: Any) -> Tuple[str, str, str]:
    if not email or not isinstance(email, str):
        return "", "", ""
    value = email.strip().lower()
    local, _, domain = value.partition("@")
    if "+" in local:
        local = local.split("+", 1)[0]
    local_alias = local.replace(".", "")
    return value, local_alias, domain


def _ensure_list(value: Any) -> List[str]:
    if isinstance(value, list):
        return [str(v) for v in value if v]
    if isinstance(value, str):
        return [value]
    return []


def _normalize_students(records: Iterable[dict]) -> Dict[str, StudentRecord]:
    normalized: Dict[str, StudentRecord] = {}
    for record in records:
        record_id = record.get("id")
        fields = record.get("fields", {})
        if not record_id:
            continue
        # Airtable field names + field IDs + short aliases
        first = _extract_field(
            fields,
            "Student's Legal First Name (as stated on their birth certificate)",
            "fldVGRpEqAyKv0o0g",
            "legal_first_name", "first_name",
        )
        last = _extract_field(
            fields,
            "Student's Legal Last Name",
            "fldYFqpLyiA5FXwpO",
            "legal_last_name", "last_name", "last",
        )
        fallback_name = _extract_field(fields, "Student's Full Name", "fldFgTbOOat95IfWW", "name", "full_name")
        full_name = " ".join(filter(None, [first, last])) or (fallback_name or "")
        normalized_name = normalize_name(full_name)
        last_name_norm = normalize_name(last or (full_name.split()[-1] if full_name else ""))
        dob = _parse_dob(_extract_field(
            fields,
            "Student's Birthdate",
            "fldya31Cb8IADmmkp",
            "date_of_birth", "dob", "birth_date",
        ))
        email, email_local, email_domain = _normalize_email(_extract_field(
            fields,
            "First Parent Email",
            "fldaEwA1EIyVO3iiZ",
            "primary_email", "email",
        ))
        phone = str(_extract_field(
            fields,
            "Primary Contact Phone Number (Cell phone)",
            "fldwQc1nQ7WyYeZLY",
            "primary_phone", "phone",
        ) or "")
        normalized[record_id] = StudentRecord(
            record_id=record_id,
            name=full_name.strip(),
            normalized_name=normalized_name,
            last_name_norm=last_name_norm,
            last_name_soundex=_soundex(last_name_norm),
            campus="",
            grade="",
            parents=set(),
            truth_id="",
            dob=dob,
            email=email,
            email_local=email_local,
            email_domain=email_domain,
            phone=phone,
            normalized_phone=normalize_phone(phone),
        )
    return normalized


def _normalize_parents(records: Iterable[dict]) -> Dict[str, ParentRecord]:
    normalized: Dict[str, ParentRecord] = {}
    for record in records:
        record_id = record.get("id")
        fields = record.get("fields", {})
        if not record_id:
            continue
        full_name = str(_extract_field(
            fields,
            "Full Name",              # Airtable field name
            "fldaSvOZOctraCWuB",      # Airtable field ID
            "full_name", "name",
        ) or "").strip()
        normalized_name = normalize_name(full_name)
        email, _, _ = _normalize_email(_extract_field(
            fields,
            "Email",                  # Airtable field name
            "fld04xn6QzH3sBqGC",     # Airtable field ID
            "contact_email", "email", "primary_email",
        ))
        phone = str(_extract_field(
            fields,
            "Phone - Parent/Guardian 1",  # Airtable field name
            "fldG54G4X7JE0br0o",          # Airtable field ID
            "contact_phone", "phone", "primary_phone",
        ) or "")
        students = set(_ensure_list(_extract_field(
            fields,
            "Student",                # Airtable field name (linked records)
            "fldvkauZW6jkGpAUO",      # Airtable field ID
            "students", "linked_students",
        )))
        address = str(_extract_field(
            fields,
            "Zip code - Parent/Guardian 1",  # Airtable field name
            "fldsySXO32UtI5ooJ",             # Airtable field ID
            "mailing_zip", "zip_code", "postal_code",
        ) or "")
        normalized[record_id] = ParentRecord(
            record_id=record_id,
            name=full_name,
            normalized_name=normalized_name,
            last_name_soundex=_soundex(normalize_name(full_name).split(" ")[-1] if full_name else ""),
            students=students,
            email=email,
            normalized_email=email,
            phone=phone,
            normalized_phone=normalize_phone(phone),
            address_zip=address.strip(),
        )
    return normalized


def _normalize_contractors(records: Iterable[dict]) -> Dict[str, ContractorRecord]:
    normalized: Dict[str, ContractorRecord] = {}
    for record in records:
        record_id = record.get("id")
        fields = record.get("fields", {})
        if not record_id:
            continue
        legal_name = str(_extract_field(
            fields,
            "Name",                   # Airtable field name (formula: Last, First)
            "fldrrJCID03zcwOlc",      # Airtable field ID
            "legal_name", "name",
        ) or "").strip()
        normalized_name = normalize_name(legal_name)
        email, _, _ = _normalize_email(_extract_field(
            fields,
            "Email",                  # Airtable field name
            "flddCJDACjAsP1ltS",      # Airtable field ID
            "email",
        ))
        phone = str(_extract_field(
            fields,
            "Cell phone",             # Airtable field name
            "fldWBnA5Xf6eQATOi",     # Airtable field ID
            "phone",
        ) or "")
        # Removed: campuses and ein are no longer used for duplicate detection
        # Set to empty defaults to prevent downstream logic from using them
        normalized[record_id] = ContractorRecord(
            record_id=record_id,
            name=legal_name,
            normalized_name=normalized_name,
            name_soundex=_soundex(normalized_name),
            email=email,
            normalized_email=email,
            phone=phone,
            normalized_phone=normalize_phone(phone),
            campuses=set(),  # No longer extracted - set to empty
            ein="",  # No longer extracted - set to empty
        )
    return normalized


# ---------------------------------------------------------------------------
# Duplicate detection per entity
# ---------------------------------------------------------------------------


def _process_students(
    raw_records: List[dict],
    dup_def: Optional[DuplicateDefinition] = None,
    run_id: Optional[str] = None,
    firestore_writer=None,
) -> List[IssuePayload]:
    def console_log(level: str, message: str):
        if level == "info":
            logger.info(message)
        elif level == "warning":
            logger.warning(message)
        if run_id and firestore_writer:
            try:
                firestore_writer.write_log(run_id, level, f"[DUPLICATES] {message}")
            except Exception:
                pass

    normalized = _normalize_students(raw_records)

    # Diagnostic: print to stdout AND write to Firestore for maximum visibility
    has_name = sum(1 for r in normalized.values() if r.normalized_name)
    has_dob = sum(1 for r in normalized.values() if r.dob)
    has_last = sum(1 for r in normalized.values() if r.last_name_norm)
    sample_fields = list(raw_records[0].get("fields", {}).keys())[:15] if raw_records else []
    # Sample a raw DOB value for debugging
    sample_dob_raw = None
    if raw_records:
        for rec in raw_records[:5]:
            v = rec.get("fields", {}).get("Student's Birthdate")
            if v is not None:
                sample_dob_raw = f"{v!r} (type={type(v).__name__})"
                break
    diag = f"STUDENT-DIAG: {len(normalized)} students, {has_name} with name, {has_last} with last_name, {has_dob} with DOB | sample_dob_raw: {sample_dob_raw} | fields: {sample_fields}"
    print(diag, flush=True)
    logger.warning(diag)
    console_log("info", f"Student normalization: {len(normalized)} total, {has_name} with name, {has_last} with last name, {has_dob} with DOB")
    console_log("info", f"Sample raw field names: {sample_fields}")

    # Check if dup_def has any rules (not just if it exists)
    has_rules = dup_def and ((dup_def.likely and len(dup_def.likely) > 0) or (dup_def.possible and len(dup_def.possible) > 0))
    if has_rules:
        rule_count = len(dup_def.likely or []) + len(dup_def.possible or [])
        console_log("info", f"Using rule-based classifier with {len(dup_def.likely or [])} likely, {len(dup_def.possible or [])} possible rules")
        classifier = lambda a, b: _classify_pair(a, b, "student", dup_def)
    else:
        if dup_def:
            console_log("warning", "DuplicateDefinition exists for students but has no rules - falling back to hardcoded logic")
        console_log("info", "Using hardcoded student classifier (name + DOB)")
        classifier = _classify_student_pair
    pairs = _detect_pairs(normalized, classifier, console_log)
    console_log("info", f"Student duplicate detection found {len(pairs)} pairs from {len(normalized)} records")
    return _build_group_issues("student", normalized, pairs)


def _process_parents(raw_records: List[dict], dup_def: Optional[DuplicateDefinition] = None) -> List[IssuePayload]:
    normalized = _normalize_parents(raw_records)
    # Check if dup_def has any rules (not just if it exists)
    has_rules = dup_def and ((dup_def.likely and len(dup_def.likely) > 0) or (dup_def.possible and len(dup_def.possible) > 0))
    if has_rules:
        classifier = lambda a, b: _classify_pair(a, b, "parent", dup_def)
    else:
        if dup_def:
            logger.warning("DuplicateDefinition exists for parents but has no rules - falling back to hardcoded logic")
        classifier = _classify_parent_pair
    pairs = _detect_pairs(normalized, classifier)
    return _build_group_issues("parent", normalized, pairs)


def _process_contractors(
    raw_records: List[dict], 
    dup_def: Optional[DuplicateDefinition] = None,
    run_id: Optional[str] = None,
    firestore_writer = None
) -> List[IssuePayload]:
    def console_log(level: str, message: str):
        """Helper to log to both logger and browser console"""
        if level == "info":
            logger.info(message)
        elif level == "warning":
            logger.warning(message)
        elif level == "error":
            logger.error(message)
        
        if run_id and firestore_writer:
            try:
                firestore_writer.write_log(run_id, level, f"[DUPLICATES] {message}")
            except Exception:
                pass
    
    normalized = _normalize_contractors(raw_records)
    # Always use hardcoded priority-based classifier (email → phone → name)
    console_log("info", "Using priority-based duplicate detection for contractors: email → phone → name")
    logger.info("Using priority-based duplicate detection for contractors: email → phone → name")
    classifier = _classify_contractor_pair
    pairs = _detect_pairs(normalized, classifier, console_log)
    console_log("info", f"Found {len(pairs)} duplicate pairs for contractors")
    return _build_group_issues("contractor", normalized, pairs)


def _detect_pairs(
    normalized: Dict[str, Any],
    classifier: Callable[[Any, Any], Optional[PairMatch]],
    console_log=None,
) -> List[PairMatch]:
    buckets = _build_blocks(normalized)
    seen_pairs: Set[Tuple[str, str]] = set()
    matches: List[PairMatch] = []
    
    total_buckets = len(buckets)
    total_pairs_evaluated = 0
    pairs_by_block_type: Dict[str, int] = {}

    # Maximum block size to prevent O(n²) explosion on common names
    MAX_BLOCK_SIZE = 100
    
    for block_key, bucket in buckets.items():
        if len(bucket) < 2:
            continue
        
        # Skip blocks that are too large - likely false positives from common names
        if len(bucket) > MAX_BLOCK_SIZE:
            if console_log:
                console_log("warning", f"Skipping large block {block_key[:50]}... with {len(bucket)} records (max: {MAX_BLOCK_SIZE})")
            continue
        
        block_type = block_key.split(":")[0] if ":" in block_key else "unknown"
        pairs_in_bucket = 0
        for a_id, b_id in combinations(bucket, 2):
            pair_key = tuple(sorted((a_id, b_id)))
            if pair_key in seen_pairs:
                continue
            seen_pairs.add(pair_key)
            record_a = normalized[a_id]
            record_b = normalized[b_id]
            match = classifier(record_a, record_b)
            total_pairs_evaluated += 1
            pairs_in_bucket += 1
            if match:
                matches.append(match)
        if pairs_in_bucket > 0:
            pairs_by_block_type[block_type] = pairs_by_block_type.get(block_type, 0) + pairs_in_bucket
    
    if console_log:
        console_log("info", f"Blocking stats - total blocks: {total_buckets}, pairs evaluated: {total_pairs_evaluated}, pairs by block type: {pairs_by_block_type}")
    
    return matches


def _build_blocks(normalized: Dict[str, Any]) -> Dict[str, List[str]]:
    buckets: Dict[str, List[str]] = {}
    for record_id, record in normalized.items():
        block_keys = _compute_blocks(record)
        for key in block_keys:
            if not key:
                continue
            buckets.setdefault(key, []).append(record_id)
    return buckets


def _compute_blocks(record: Any) -> List[str]:
    keys = []
    if isinstance(record, StudentRecord):
        # Block by last name soundex + DOB (primary blocking strategy)
        if record.last_name_soundex and record.dob:
            keys.append(f"s:{record.last_name_soundex}:{record.dob}")
        # Block by last name soundex alone to catch DOB typos
        if record.last_name_soundex:
            keys.append(f"s:lastname:{record.last_name_soundex}")
    elif isinstance(record, ParentRecord):
        if record.normalized_email:
            keys.append(f"p:email:{record.normalized_email}")
        if record.normalized_phone:
            keys.append(f"p:phone:{record.normalized_phone}")
        if record.last_name_soundex and record.address_zip:
            keys.append(f"p:{record.last_name_soundex}:{record.address_zip}")
    elif isinstance(record, ContractorRecord):
        # Only block by email or phone - name blocking removed
        if record.normalized_email:
            keys.append(f"c:email:{record.normalized_email}")
        if record.normalized_phone:
            keys.append(f"c:phone:{record.normalized_phone}")
    return keys


# ---------------------------------------------------------------------------
# Rule-based classification logic
# ---------------------------------------------------------------------------


def _evaluate_rule(
    rule: DuplicateRule,
    record_a: Any,
    record_b: Any,
    entity: str,
    match_type: str,
    console_log=None,
) -> Optional[PairMatch]:
    """Evaluate a duplicate rule against two records.
    
    Args:
        rule: DuplicateRule to evaluate
        record_a: First normalized record
        record_b: Second normalized record
        entity: Entity type ("student", "parent", "contractor")
        match_type: "likely" or "possible"
        console_log: Optional logging function for frontend visibility
        
    Returns:
        PairMatch if all conditions match, None otherwise
    """
    all_evidence: Dict[str, Any] = {}
    all_conditions_match = True
    failed_condition = None
    
    for condition in rule.conditions:
        matches, evidence = evaluate_condition(condition, record_a, record_b, entity)
        all_evidence.update(evidence)
        
        if not matches:
            all_conditions_match = False
            failed_condition = {
                "type": condition.type,
                "field": getattr(condition, "field", None),
                "evidence": evidence
            }
            break
    
    if not all_conditions_match:
        if console_log and entity == "contractor":
            # Only log for contractors to avoid spam
            record_a_name = getattr(record_a, "normalized_name", "unknown")
            record_b_name = getattr(record_b, "normalized_name", "unknown")
            console_log("debug", f"Rule {rule.rule_id} failed for {record_a_name} vs {record_b_name} - failed condition: {failed_condition}")
        return None
    
    # Calculate confidence based on match type and evidence
    confidence = 0.95 if match_type == "likely" else 0.7
    
    # Adjust confidence based on evidence quality
    if "similarity" in str(all_evidence):
        for key, value in all_evidence.items():
            if isinstance(value, dict) and "similarity" in value:
                confidence = max(confidence, value.get("similarity", 0.7))
    
    return PairMatch(
        entity=entity,
        primary_id=record_a.record_id,
        secondary_id=record_b.record_id,
        rule_id=rule.rule_id,
        match_type=match_type,
        severity=rule.severity or (LIKELY_SEVERITY if match_type == "likely" else POSSIBLE_SEVERITY),
        confidence=round(confidence, 3),
        evidence=all_evidence,
    )


def _classify_pair(
    record_a: Any,
    record_b: Any,
    entity: str,
    dup_def: DuplicateDefinition,
    console_log=None,
) -> Optional[PairMatch]:
    """Generic rule-based classifier for duplicate pairs.
    
    Args:
        record_a: First normalized record
        record_b: Second normalized record
        entity: Entity type ("student", "parent", "contractor")
        dup_def: DuplicateDefinition with likely/possible rules
        console_log: Optional logging function for frontend visibility
        
    Returns:
        PairMatch if any rule matches, None otherwise
    """
    # Try likely rules first
    for rule in dup_def.likely:
        match = _evaluate_rule(rule, record_a, record_b, entity, "likely", console_log)
        if match:
            return match
    
    # Then try possible rules
    for rule in dup_def.possible:
        match = _evaluate_rule(rule, record_a, record_b, entity, "possible", console_log)
        if match:
            return match
    
    return None


# ---------------------------------------------------------------------------
# Legacy hardcoded classification logic (fallback)
# ---------------------------------------------------------------------------


def _classify_student_pair(a: StudentRecord, b: StudentRecord) -> Optional[PairMatch]:
    """Fallback hardcoded classifier: name similarity + DOB match only."""
    evidence: Dict[str, Any] = {}

    name_similarity = jaro_winkler(a.normalized_name, b.normalized_name)
    evidence["name_similarity"] = round(name_similarity, 3)
    dob_match = bool(a.dob and b.dob and abs((a.dob - b.dob).days) <= 1)
    evidence["dob_match"] = dob_match

    # Likely: high name similarity + matching DOB
    if name_similarity >= 0.8 and dob_match:
        return PairMatch(
            entity="student",
            primary_id=a.record_id,
            secondary_id=b.record_id,
            rule_id="dup.student.name_dob",
            match_type="likely",
            severity=LIKELY_SEVERITY,
            confidence=round(max(name_similarity, 0.9), 3),
            evidence=evidence,
        )

    # Possible: very high name similarity without DOB
    if name_similarity >= 0.92:
        return PairMatch(
            entity="student",
            primary_id=a.record_id,
            secondary_id=b.record_id,
            rule_id="dup.student.name_only",
            match_type="possible",
            severity=POSSIBLE_SEVERITY,
            confidence=round(name_similarity * 0.7, 3),
            evidence=evidence,
        )

    return None


def _classify_parent_pair(a: ParentRecord, b: ParentRecord) -> Optional[PairMatch]:
    evidence: Dict[str, Any] = {}
    if a.normalized_email and a.normalized_email == b.normalized_email:
        evidence["email_match"] = True
        return PairMatch(
            entity="parent",
            primary_id=a.record_id,
            secondary_id=b.record_id,
            rule_id="dup.parent.email",
            match_type="likely",
            severity=LIKELY_SEVERITY,
            confidence=0.95,
            evidence=evidence,
        )
    if a.normalized_phone and a.normalized_phone == b.normalized_phone:
        evidence["phone_match"] = True
        return PairMatch(
            entity="parent",
            primary_id=a.record_id,
            secondary_id=b.record_id,
            rule_id="dup.parent.phone",
            match_type="likely",
            severity=LIKELY_SEVERITY,
            confidence=0.9,
            evidence=evidence,
        )

    name_similarity = jaro_winkler(a.normalized_name, b.normalized_name)
    evidence["name_similarity"] = round(name_similarity, 3)
    student_overlap = jaccard_ratio(a.students, b.students)
    evidence["student_overlap"] = round(student_overlap, 3)

    if name_similarity >= 0.92 and student_overlap >= 0.5:
        return PairMatch(
            entity="parent",
            primary_id=a.record_id,
            secondary_id=b.record_id,
            rule_id="dup.parent.name_student",
            match_type="possible",
            severity=POSSIBLE_SEVERITY,
            confidence=0.7,
            evidence=evidence,
        )
    if a.address_zip and a.address_zip == b.address_zip and name_similarity >= 0.9:
        return PairMatch(
            entity="parent",
            primary_id=a.record_id,
            secondary_id=b.record_id,
            rule_id="dup.parent.address",
            match_type="possible",
            severity=POSSIBLE_SEVERITY,
            confidence=0.65,
            evidence=evidence,
        )
    return None


def _classify_contractor_pair(a: ContractorRecord, b: ContractorRecord) -> Optional[PairMatch]:
    """Simple priority-based duplicate detection: Email → Phone → Name (0.8 threshold).
    
    Only checks fields when BOTH records have them. Stops at first match.
    All comparisons are case-insensitive.
    """
    evidence: Dict[str, Any] = {}
    
    # Priority 1: Email (if both have email) - case-insensitive
    if a.normalized_email and b.normalized_email:
        if a.normalized_email.lower() == b.normalized_email.lower():
            evidence["email_match"] = True
            return PairMatch(
                entity="contractor",
                primary_id=a.record_id,
                secondary_id=b.record_id,
                rule_id="dup.contractor.email",
                match_type="likely",
                severity=LIKELY_SEVERITY,
                confidence=0.95,
                evidence=evidence,
            )
    
    # Priority 2: Phone (if both have phone) - already normalized (digits only)
    if a.normalized_phone and b.normalized_phone:
        if a.normalized_phone == b.normalized_phone:
            evidence["phone_match"] = True
            return PairMatch(
                entity="contractor",
                primary_id=a.record_id,
                secondary_id=b.record_id,
                rule_id="dup.contractor.phone",
                match_type="likely",
                severity=LIKELY_SEVERITY,
                confidence=0.9,
                evidence=evidence,
            )
    
    # Priority 3: Name similarity (if both have name) - case-insensitive, threshold 0.8
    if a.normalized_name and b.normalized_name:
        name_a = a.normalized_name.lower().strip()
        name_b = b.normalized_name.lower().strip()
        if name_a and name_b:
            similarity = jaro_winkler(name_a, name_b)
            evidence["name_similarity"] = round(similarity, 3)
            if similarity >= 0.8:
                return PairMatch(
                    entity="contractor",
                    primary_id=a.record_id,
                    secondary_id=b.record_id,
                    rule_id="dup.contractor.name",
                    match_type="likely",
                    severity=LIKELY_SEVERITY,
                    confidence=round(similarity, 3),
                    evidence=evidence,
                )
    
    return None


# ---------------------------------------------------------------------------
# Grouping logic
# ---------------------------------------------------------------------------


def _build_group_issues(
    entity: str,
    normalized: Dict[str, Any],
    matches: List[PairMatch],
) -> List[IssuePayload]:
    if not matches:
        return []

    parent: Dict[str, str] = {}

    def find(x: str) -> str:
        parent.setdefault(x, x)
        if parent[x] != x:
            parent[x] = find(parent[x])
        return parent[x]

    def union(x: str, y: str) -> None:
        root_x = find(x)
        root_y = find(y)
        if root_x != root_y:
            parent[root_y] = root_x

    for match in matches:
        union(match.primary_id, match.secondary_id)

    groups: Dict[str, Set[str]] = {}
    for record_id in normalized:
        root = find(record_id)
        groups.setdefault(root, set()).add(record_id)

    issues: List[IssuePayload] = []
    severity_rank = {"info": 0, "warning": 1, "critical": 2}

    for root, members in groups.items():
        if len(members) < 2:
            continue
        member_ids = sorted(members)
        group_matches = [m for m in matches if m.primary_id in members and m.secondary_id in members]
        top_match = max(group_matches, key=lambda m: severity_rank.get(m.severity, 0))
        related = [m for m in member_ids]
        primary_id = _select_primary(entity, members, normalized)
        related.remove(primary_id)
        group_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"{entity}:{'|'.join(member_ids)}"))
        description = f"{entity.title()} duplicate group with {len(members)} records (primary {primary_id})."
        metadata = _serialize_for_firestore({
            "group_id": group_id,
            "members": member_ids,
            "match_types": [m.match_type for m in group_matches],
            "confidences": [m.confidence for m in group_matches],
            "evidence_samples": group_matches[0].evidence if group_matches else {},
        })
        issues.append(
            IssuePayload(
                rule_id=top_match.rule_id,
                issue_type="duplicate",
                entity=entity,
                record_id=primary_id,
                severity=top_match.severity,
                description=description,
                metadata=metadata,
                related_records=related,
            )
        )
    return issues


def _select_primary(entity: str, members: Set[str], normalized: Dict[str, Any]) -> str:
    def completeness(record: Any) -> int:
        if isinstance(record, StudentRecord):
            return sum(
                bool(value)
                for value in [
                    record.name,
                    record.dob,
                    record.email,
                    record.phone,
                ]
            )
        if isinstance(record, ParentRecord):
            return sum(bool(value) for value in [record.email, record.phone, record.students])
        if isinstance(record, ContractorRecord):
            # Removed: ein and campuses - no longer used for duplicate detection
            return sum(bool(value) for value in [record.email, record.phone])
        return 0

    return max(members, key=lambda record_id: (completeness(normalized[record_id]), record_id))
