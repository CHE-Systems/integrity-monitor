"""Condition evaluators for duplicate detection rules."""

from __future__ import annotations

from datetime import date
from typing import Any, Dict, Optional, Tuple

from ..config.models import DuplicateCondition
from ..utils.similarity import jaccard_ratio, jaro_winkler

# Field mapping from config field names to normalized record attributes
STUDENT_FIELD_MAP = {
    # Short aliases used in Firestore rule conditions
    "legal_first_name": "normalized_name",
    "legal_last_name": "last_name_norm",
    "date_of_birth": "dob",
    "primary_email": "email",
    "primary_phone": "normalized_phone",
    # Full Airtable field names
    "Student's Legal First Name (as stated on their birth certificate)": "normalized_name",
    "Student's Legal Last Name": "last_name_norm",
    "Student's Birthdate": "dob",
    "First Parent Email": "email",
    "Primary Contact Phone Number (Cell phone)": "normalized_phone",
    # Airtable field IDs
    "fldVGRpEqAyKv0o0g": "normalized_name",  # First Name
    "fldYFqpLyiA5FXwpO": "last_name_norm",   # Last Name
    "fldya31Cb8IADmmkp": "dob",               # Birthdate
    "fldaEwA1EIyVO3iiZ": "email",             # First Parent Email
    "fldwQc1nQ7WyYeZLY": "normalized_phone",  # Primary Contact Phone
}

PARENT_FIELD_MAP = {
    # Short aliases
    "contact_email": "email",
    "email": "email",
    "primary_email": "email",
    "contact_phone": "normalized_phone",
    "phone": "normalized_phone",
    "primary_phone": "normalized_phone",
    "full_name": "normalized_name",
    "name": "normalized_name",
    "linked_students": "students",
    "students": "students",
    "mailing_zip": "address_zip",
    "zip_code": "address_zip",
    "postal_code": "address_zip",
    # Full Airtable field names
    "Full Name": "normalized_name",
    "Email": "email",
    "Phone - Parent/Guardian 1": "normalized_phone",
    "Student": "students",
    "Zip code - Parent/Guardian 1": "address_zip",
    # Airtable field IDs
    "fldaSvOZOctraCWuB": "normalized_name",    # Full Name
    "fld04xn6QzH3sBqGC": "email",              # Email
    "fldG54G4X7JE0br0o": "normalized_phone",   # Phone - Parent/Guardian 1
    "fldvkauZW6jkGpAUO": "students",           # Student (linked records)
    "fldsySXO32UtI5ooJ": "address_zip",        # Zip code - Parent/Guardian 1
}

CONTRACTOR_FIELD_MAP = {
    # Short aliases
    "email": "email",
    "phone": "normalized_phone",
    "legal_name": "normalized_name",
    "name": "normalized_name",
    # Full Airtable field names
    "Name": "normalized_name",
    "Email": "email",
    "Cell phone": "normalized_phone",
    # Airtable field IDs
    "fldrrJCID03zcwOlc": "normalized_name",   # Name (formula: Last, First)
    "flddCJDACjAsP1ltS": "email",             # Email
    "fldWBnA5Xf6eQATOi": "normalized_phone",  # Cell phone
}


def get_field_value(record: Any, field_name: str, entity: str) -> Any:
    """Get field value from normalized record using config field name.
    
    Args:
        record: Normalized record (StudentRecord, ParentRecord, or ContractorRecord)
        field_name: Field name from config (e.g., "primary_email")
        entity: Entity type ("student", "parent", "contractor")
        
    Returns:
        Field value or None if not found
    """
    field_map = {
        "student": STUDENT_FIELD_MAP,
        "parent": PARENT_FIELD_MAP,
        "contractor": CONTRACTOR_FIELD_MAP,
    }.get(entity, {})
    
    mapped_field = field_map.get(field_name)
    if mapped_field is None:
        return None
    
    return getattr(record, mapped_field, None)


def get_composite_field_value(record: Any, field_names: list[str], entity: str) -> str:
    """Get composite field value by combining multiple fields.
    
    Used for similarity checks on multiple fields (e.g., first_name + last_name).
    
    Args:
        record: Normalized record
        field_names: List of config field names to combine
        entity: Entity type
        
    Returns:
        Combined normalized string
    """
    # Special handling for student name fields - use normalized_name if both first and last are requested
    if entity == "student" and len(field_names) == 2:
        first_name_keys = {"legal_first_name", "fldVGRpEqAyKv0o0g",
                           "Student's Legal First Name (as stated on their birth certificate)"}
        last_name_keys = {"legal_last_name", "fldYFqpLyiA5FXwpO", "Student's Legal Last Name"}
        if (set(field_names) & first_name_keys) and (set(field_names) & last_name_keys):
            return getattr(record, "normalized_name", "") or ""
    
    values = []
    for field_name in field_names:
        value = get_field_value(record, field_name, entity)
        if value:
            values.append(str(value))
    
    return " ".join(values).strip()


def evaluate_condition(
    condition: DuplicateCondition,
    record_a: Any,
    record_b: Any,
    entity: str,
) -> Tuple[bool, Dict[str, Any]]:
    """Evaluate a duplicate condition against two records.
    
    Args:
        condition: DuplicateCondition to evaluate
        record_a: First normalized record
        record_b: Second normalized record
        entity: Entity type ("student", "parent", "contractor")
        
    Returns:
        Tuple of (matches: bool, evidence: dict)
    """
    condition_type = condition.type
    
    if condition_type == "exact_match":
        return _evaluate_exact_match(condition, record_a, record_b, entity)
    elif condition_type == "similarity":
        return _evaluate_similarity(condition, record_a, record_b, entity)
    elif condition_type == "date_delta":
        return _evaluate_date_delta(condition, record_a, record_b, entity)
    elif condition_type == "set_overlap":
        return _evaluate_set_overlap(condition, record_a, record_b, entity)
    else:
        return False, {"error": f"Unknown condition type: {condition_type}"}


def _evaluate_exact_match(
    condition: DuplicateCondition,
    record_a: Any,
    record_b: Any,
    entity: str,
) -> Tuple[bool, Dict[str, Any]]:
    """Evaluate exact_match condition."""
    if condition.field:
        value_a = get_field_value(record_a, condition.field, entity)
        value_b = get_field_value(record_b, condition.field, entity)
        
        # Special handling for email fields: skip check if either value is missing
        # This allows name-only matching when emails are missing
        if condition.field in ("email", "primary_email", "contact_email"):
            if value_a is None or value_b is None:
                return True, {condition.field: {"a": value_a, "b": value_b, "match": "skipped_missing"}}
        
        # For other fields, require both values to be present
        if value_a is None or value_b is None:
            return False, {condition.field: {"a": value_a, "b": value_b, "match": False}}
        
        matches = value_a == value_b
        return matches, {condition.field: {"a": value_a, "b": value_b, "match": matches}}
    
    return False, {"error": "exact_match condition requires 'field'"}


def _evaluate_similarity(
    condition: DuplicateCondition,
    record_a: Any,
    record_b: Any,
    entity: str,
) -> Tuple[bool, Dict[str, Any]]:
    """Evaluate similarity condition."""
    if condition.similarity is None:
        return False, {"error": "similarity condition requires 'similarity' threshold"}
    
    if condition.fields:
        # Composite field similarity (e.g., first_name + last_name)
        value_a = get_composite_field_value(record_a, condition.fields, entity)
        value_b = get_composite_field_value(record_b, condition.fields, entity)
        field_key = "_".join(condition.fields)
    elif condition.field:
        value_a = get_field_value(record_a, condition.field, entity)
        value_b = get_field_value(record_b, condition.field, entity)
        field_key = condition.field
    else:
        return False, {"error": "similarity condition requires 'field' or 'fields'"}
    
    if not value_a or not value_b:
        return False, {field_key: {"a": value_a, "b": value_b, "similarity": 0.0, "match": False}}
    
    # Convert to strings for comparison
    str_a = str(value_a).strip()
    str_b = str(value_b).strip()
    
    if not str_a or not str_b:
        return False, {field_key: {"a": str_a, "b": str_b, "similarity": 0.0, "match": False}}
    
    similarity_score = jaro_winkler(str_a, str_b)
    matches = similarity_score >= condition.similarity
    
    return matches, {
        field_key: {
            "a": str_a,
            "b": str_b,
            "similarity": round(similarity_score, 3),
            "threshold": condition.similarity,
            "match": matches,
        }
    }


def _evaluate_date_delta(
    condition: DuplicateCondition,
    record_a: Any,
    record_b: Any,
    entity: str,
) -> Tuple[bool, Dict[str, Any]]:
    """Evaluate date_delta condition."""
    if condition.field is None:
        return False, {"error": "date_delta condition requires 'field'"}
    
    if condition.tolerance_days is None:
        return False, {"error": "date_delta condition requires 'tolerance_days'"}
    
    value_a = get_field_value(record_a, condition.field, entity)
    value_b = get_field_value(record_b, condition.field, entity)
    
    if not value_a or not value_b:
        return False, {condition.field: {"a": value_a, "b": value_b, "match": False}}
    
    # Handle date objects
    date_a = value_a if isinstance(value_a, date) else None
    date_b = value_b if isinstance(value_b, date) else None
    
    if not date_a or not date_b:
        return False, {condition.field: {"a": value_a, "b": value_b, "match": False}}
    
    delta_days = abs((date_a - date_b).days)
    matches = delta_days <= condition.tolerance_days
    
    return matches, {
        condition.field: {
            "a": str(date_a),
            "b": str(date_b),
            "delta_days": delta_days,
            "tolerance_days": condition.tolerance_days,
            "match": matches,
        }
    }


def _evaluate_set_overlap(
    condition: DuplicateCondition,
    record_a: Any,
    record_b: Any,
    entity: str,
) -> Tuple[bool, Dict[str, Any]]:
    """Evaluate set_overlap condition."""
    if condition.field is None:
        return False, {"error": "set_overlap condition requires 'field'"}
    
    if condition.overlap_ratio is None:
        return False, {"error": "set_overlap condition requires 'overlap_ratio'"}
    
    value_a = get_field_value(record_a, condition.field, entity)
    value_b = get_field_value(record_b, condition.field, entity)
    
    if not value_a or not value_b:
        return False, {condition.field: {"a": value_a, "b": value_b, "overlap_ratio": 0.0, "match": False}}
    
    # Convert to sets
    set_a = set(value_a) if isinstance(value_a, (set, list)) else {value_a}
    set_b = set(value_b) if isinstance(value_b, (set, list)) else {value_b}
    
    # Filter out empty strings/None
    set_a = {str(v) for v in set_a if v}
    set_b = {str(v) for v in set_b if v}
    
    if not set_a or not set_b:
        return False, {condition.field: {"a": list(set_a), "b": list(set_b), "overlap_ratio": 0.0, "match": False}}
    
    overlap_ratio = jaccard_ratio(set_a, set_b)
    matches = overlap_ratio >= condition.overlap_ratio
    
    return matches, {
        condition.field: {
            "a": list(set_a),
            "b": list(set_b),
            "overlap_ratio": round(overlap_ratio, 3),
            "threshold": condition.overlap_ratio,
            "match": matches,
        }
    }
