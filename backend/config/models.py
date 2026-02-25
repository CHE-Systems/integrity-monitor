"""Pydantic models for schema and rule configuration.

These models mirror the structured content defined in
`docs/prompt-1-schema-spec.md` so the backend can reason about entities,
relationships, duplicates, and required data.
"""

from __future__ import annotations

from typing import Dict, List, Optional

from pydantic import BaseModel, Field


class FieldRequirement(BaseModel):
    field: str
    message: str
    severity: str = "warning"
    alternate_fields: Optional[List[str]] = None
    condition_field: Optional[str] = None
    condition_value: Optional[str] = None
    rule_id: Optional[str] = None  # Added to support Firestore rule IDs for filtering


class ValueCheck(BaseModel):
    field: str
    message: str = ""
    severity: str = "info"
    rule_id: Optional[str] = None
    source_entity: Optional[str] = None  # Entity to check (if different from rule's entity)
    condition_field: Optional[str] = None
    condition_value: Optional[str] = None


class RelationshipRule(BaseModel):
    target: str
    message: str
    min_links: int = 0
    max_links: Optional[int] = None
    require_active: bool = False
    allow_secondary: bool = False
    condition_field: Optional[str] = None
    condition_value: Optional[str] = None
    notes: Optional[str] = None
    validate_bidirectional: bool = False
    reverse_relationship_key: Optional[str] = None
    cross_entity_validation: Optional[Dict[str, str]] = None


class DuplicateCondition(BaseModel):
    type: str
    field: Optional[str] = None
    fields: Optional[List[str]] = None
    tolerance_days: Optional[int] = None
    similarity: Optional[float] = None
    overlap_ratio: Optional[float] = None
    value: Optional[str] = None
    description: Optional[str] = None


class DuplicateRule(BaseModel):
    rule_id: str
    description: str
    conditions: List[DuplicateCondition]
    severity: str = "warning"


class DuplicateDefinition(BaseModel):
    likely: List[DuplicateRule] = Field(default_factory=list)
    possible: List[DuplicateRule] = Field(default_factory=list)


class EntitySchema(BaseModel):
    description: str
    key_identifiers: List[str]
    identity_fields: List[str]
    relationships: Dict[str, RelationshipRule] = Field(default_factory=dict)
    missing_key_data: List[FieldRequirement] = Field(default_factory=list)
    value_checks: List[ValueCheck] = Field(default_factory=list)


class SchemaMetadata(BaseModel):
    source: str
    generated: str


class SchemaConfig(BaseModel):
    metadata: SchemaMetadata
    entities: Dict[str, EntitySchema]
    duplicates: Dict[str, DuplicateDefinition]
