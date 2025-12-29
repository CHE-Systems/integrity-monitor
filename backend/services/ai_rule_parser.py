"""AI-powered natural language rule parser with fallback to pattern matching."""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Dict, Optional

from ..utils.secrets import get_secret

logger = logging.getLogger(__name__)


class AIRuleParser:
    """Parse natural language rule descriptions into structured rule objects."""

    def __init__(self):
        """Initialize AI parser with OpenAI API key if available."""
        self.openai_api_key = get_secret("OPENAI_API_KEY")
        self.openai_enabled = bool(self.openai_api_key)

    def parse(self, description: str, category_hint: Optional[str] = None) -> Dict[str, Any]:
        """Parse natural language rule description into structured format.
        
        Args:
            description: Natural language description of the rule
            category_hint: Optional hint about rule category
        
        Returns:
            Dictionary with parsed rule structure and category
        """
        # Try AI parsing first if available
        if self.openai_enabled:
            try:
                result = self._parse_with_openai(description, category_hint)
                if result:
                    return result
            except Exception as exc:
                logger.warning(f"OpenAI parsing failed, falling back to pattern matching: {exc}")
        
        # Fallback to pattern matching
        return self._parse_with_patterns(description, category_hint)

    def _parse_with_openai(self, description: str, category_hint: Optional[str] = None) -> Optional[Dict[str, Any]]:
        """Parse using OpenAI API."""
        try:
            import openai
            
            client = openai.OpenAI(api_key=self.openai_api_key)
            
            system_prompt = """You are a rule parser for a data integrity monitoring system. 
Parse natural language rule descriptions into structured JSON format.

Rule categories:
1. duplicates - Find duplicate records (e.g., "Find duplicate students by email")
2. relationships - Link validation rules (e.g., "Students must have at least one parent")
3. required_fields - Missing field requirements (e.g., "Flag students missing email")
4. attendance_rules - Attendance thresholds (e.g., "Alert if absence rate > 20%")

Return JSON with:
- category: one of the above
- entity: entity name (students, parents, contractors, etc.)
- rule_data: structured rule object matching the category

For duplicates: {rule_id, description, conditions: [{type, field, similarity}], severity}
For relationships: {target, message, min_links, max_links, require_active}
For required_fields: {field, message, severity, alternate_fields}
For attendance_rules: {thresholds: {metric_name: {info, warning, critical}}}

Return only valid JSON, no markdown."""
            
            user_prompt = f"Parse this rule: {description}"
            if category_hint:
                user_prompt += f"\nCategory hint: {category_hint}"
            
            response = client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                temperature=0.3,
                response_format={"type": "json_object"},
            )
            
            result = json.loads(response.choices[0].message.content)
            
            # Validate and return
            if "category" in result and "rule_data" in result:
                return result
            
            logger.warning("OpenAI returned invalid structure")
            return None
            
        except ImportError:
            logger.warning("openai package not installed")
            return None
        except Exception as exc:
            logger.error(f"OpenAI parsing error: {exc}", exc_info=True)
            return None

    def _parse_with_patterns(self, description: str, category_hint: Optional[str] = None) -> Dict[str, Any]:
        """Parse using pattern matching as fallback."""
        description_lower = description.lower()
        
        # Detect category
        category = category_hint
        if not category:
            if any(word in description_lower for word in ["duplicate", "duplicate", "same", "match"]):
                category = "duplicates"
            elif any(word in description_lower for word in ["must have", "require", "need", "link", "relationship"]):
                category = "relationships"
            elif any(word in description_lower for word in ["missing", "required field", "must have field"]):
                category = "required_fields"
            elif any(word in description_lower for word in ["absence", "attendance", "tardy", "absent"]):
                category = "attendance_rules"
            else:
                category = "required_fields"  # Default
        
        # Extract entity
        entity = None
        entity_patterns = {
            "student": "students",
            "parent": "parents",
            "contractor": "contractors",
            "class": "classes",
            "payment": "payments",
        }
        for pattern, entity_name in entity_patterns.items():
            if pattern in description_lower:
                entity = entity_name
                break
        
        if not entity:
            entity = "students"  # Default
        
        # Parse based on category
        if category == "duplicates":
            return self._parse_duplicate_rule(description, entity)
        elif category == "relationships":
            return self._parse_relationship_rule(description, entity)
        elif category == "required_fields":
            return self._parse_required_field_rule(description, entity)
        elif category == "attendance_rules":
            return self._parse_attendance_rule(description)
        else:
            return {
                "category": category,
                "entity": entity,
                "rule_data": {"description": description},
            }

    def _parse_duplicate_rule(self, description: str, entity: str) -> Dict[str, Any]:
        """Parse duplicate rule from description."""
        description_lower = description.lower()
        
        # Extract field names
        fields = []
        if "email" in description_lower:
            fields.append("email")
        if "phone" in description_lower:
            fields.append("phone")
        if "name" in description_lower:
            fields.append("name")
        if "dob" in description_lower or "date of birth" in description_lower:
            fields.append("date_of_birth")
        
        if not fields:
            fields = ["email"]  # Default
        
        # Determine match type
        match_type = "exact"
        if "similar" in description_lower or "fuzzy" in description_lower:
            match_type = "similarity"
        
        rule_id = f"dup.{entity}.{fields[0]}"
        if match_type == "similarity":
            rule_id += "_similar"
        
        conditions = []
        for field in fields:
            if match_type == "exact":
                conditions.append({
                    "type": "exact_match",
                    "field": field,
                })
            else:
                conditions.append({
                    "type": "similarity",
                    "field": field,
                    "similarity": 0.8,
                })
        
        return {
            "category": "duplicates",
            "entity": entity,
            "rule_data": {
                "rule_id": rule_id,
                "description": description,
                "conditions": conditions,
                "severity": "warning",
                "confidence": "likely",
            },
        }

    def _parse_relationship_rule(self, description: str, entity: str) -> Dict[str, Any]:
        """Parse relationship rule from description."""
        description_lower = description.lower()
        
        # Extract target entity
        target = "parents"
        if "parent" in description_lower:
            target = "parents"
        elif "campus" in description_lower:
            target = "campuses"
        elif "class" in description_lower:
            target = "classes"
        elif "contractor" in description_lower:
            target = "contractors"
        
        # Extract min/max links
        min_links = 1
        max_links = None
        
        # Look for "at least X" or "exactly X" or "X or more"
        at_least_match = re.search(r"at least (\d+)", description_lower)
        if at_least_match:
            min_links = int(at_least_match.group(1))
        
        exactly_match = re.search(r"exactly (\d+)", description_lower)
        if exactly_match:
            min_links = int(exactly_match.group(1))
            max_links = min_links
        
        # Check for "require active" or "active"
        require_active = "active" in description_lower or "require active" in description_lower
        
        rule_id = f"link.{entity}.{target}"
        
        return {
            "category": "relationships",
            "entity": entity,
            "rule_data": {
                "target": target,
                "message": description,
                "min_links": min_links,
                "max_links": max_links,
                "require_active": require_active,
                "relationship_key": target.rstrip("s"),  # Remove plural
            },
        }

    def _parse_required_field_rule(self, description: str, entity: str) -> Dict[str, Any]:
        """Parse required field rule from description.
        
        Always attempts to look up field ID from schema snapshot and includes
        it in the rule_data JSON so users can see if the field was found.
        """
        description_lower = description.lower()
        
        # Extract field name with expanded patterns
        field = None
        field_patterns = {
            "email": "email",
            "phone": "phone",
            "name": "name",
            "address": "address",
            "status": "status",
            "grade": "grade_level",
            "certification": "certification",
            "background": "background check",
            "background check": "background check",
            "background_check": "background check",
        }
        
        for pattern, field_name in field_patterns.items():
            if pattern in description_lower:
                field = field_name
                break
        
        if not field:
            # Try to extract from "missing X" or "X is required" or "X field"
            missing_match = re.search(r"missing (\w+(?:\s+\w+)*)", description_lower)
            if missing_match:
                field = missing_match.group(1)
            else:
                required_match = re.search(r"(\w+(?:\s+\w+)*)\s+is required", description_lower)
                if required_match:
                    field = required_match.group(1)
                else:
                    field_match = re.search(r"(\w+(?:\s+\w+)*)\s+field", description_lower)
                    if field_match:
                        field = field_match.group(1)
                    else:
                        field = "field_name"
        
        # Always try to look up field ID from schema snapshot
        field_id = None
        field_name_resolved = field  # Store the resolved field name
        field_lookup_status = "not_found"
        field_lookup_message = None
        
        try:
            from pathlib import Path
            import json
            from ..utils.records import _normalize_name
            
            schema_path = Path(__file__).resolve().parent.parent / "config" / "airtable_schema.json"
            if not schema_path.exists():
                field_lookup_status = "schema_not_found"
                field_lookup_message = "Schema snapshot not found. Run airtable_records_snapshot to generate it."
                logger.warning(f"Schema snapshot not found at {schema_path}")
            else:
                with schema_path.open("r", encoding="utf-8") as f:
                    schema = json.load(f)
                
                # Map entity to table name
                entity_to_table = {
                    "contractors": "Contractors/Volunteers",
                    "students": "Students",
                    "parents": "Parents",
                    "classes": "Classes",
                    "attendance": "Attendance",
                    "truth": "Truth",
                    "payments": "Contractor/Vendor Invoices",
                }
                table_name = entity_to_table.get(entity, entity.title())
                
                # Find the target table
                target_table = None
                for table in schema.get("tables", []):
                    table_name_lower = table.get("name", "").lower()
                    if (table.get("name") == table_name or 
                        entity.lower() in table_name_lower or
                        table_name_lower in entity.lower()):
                        target_table = table
                        break
                
                if not target_table:
                    field_lookup_status = "table_not_found"
                    field_lookup_message = f"Table not found for entity '{entity}' in schema"
                    logger.warning(f"Table not found for entity: {entity}")
                else:
                    # Try multiple matching strategies
                    normalized_field = _normalize_name(field)
                    field_variants = [
                        field,  # Original
                        field.replace("_", " "),  # Underscore to space
                        field.replace(" ", "_"),  # Space to underscore
                        normalized_field,  # Normalized
                    ]
                    
                    # Find field by name (try exact match, then normalized, then contains)
                    for schema_field in target_table.get("fields", []):
                        schema_field_name = schema_field.get("name", "")
                        schema_field_normalized = _normalize_name(schema_field_name)
                        
                        # Try exact match first
                        if (schema_field_name.lower() == field.lower() or
                            schema_field_normalized == normalized_field):
                            field_id = schema_field.get("id")
                            field_name_resolved = schema_field_name
                            field_lookup_status = "found"
                            field_lookup_message = f"Found field '{schema_field_name}' (ID: {field_id})"
                            logger.info(f"Found field ID for '{field}': {field_id} ({schema_field_name})")
                            break
                    
                    # If not found, try partial/contains match
                    if not field_id:
                        for schema_field in target_table.get("fields", []):
                            schema_field_name = schema_field.get("name", "")
                            schema_field_normalized = _normalize_name(schema_field_name)
                            
                            # Check if field name contains our search term or vice versa
                            if (normalized_field in schema_field_normalized or
                                schema_field_normalized in normalized_field):
                                field_id = schema_field.get("id")
                                field_name_resolved = schema_field_name
                                field_lookup_status = "found_partial"
                                field_lookup_message = f"Found similar field '{schema_field_name}' (ID: {field_id})"
                                logger.info(f"Found partial match for '{field}': {field_id} ({schema_field_name})")
                                break
                    
                    if not field_id:
                        field_lookup_status = "field_not_found"
                        field_lookup_message = f"Field '{field}' not found in table '{target_table.get('name')}'"
                        logger.warning(f"Field '{field}' not found in table '{target_table.get('name')}' for entity '{entity}'")
                        
        except Exception as exc:
            field_lookup_status = "error"
            field_lookup_message = f"Error looking up field: {str(exc)}"
            logger.error(f"Could not look up field ID for {field}: {exc}", exc_info=True)
        
        # Determine severity
        severity = "warning"
        if "critical" in description_lower or "must" in description_lower:
            severity = "critical"
        elif "info" in description_lower or "optional" in description_lower:
            severity = "info"
        
        rule_data = {
            "field": field_name_resolved,  # Use resolved field name
            "message": description,
            "severity": severity,
        }
        
        # Always include field lookup information in rule_data
        if field_id:
            rule_data["field_id"] = field_id
            rule_data["field_lookup_status"] = "found"
        else:
            rule_data["field_lookup_status"] = field_lookup_status
        
        # Include lookup message for user feedback
        if field_lookup_message:
            rule_data["field_lookup_message"] = field_lookup_message
        
        # Include field_name for display (same as field for now, but can be edited)
        rule_data["field_name"] = field_name_resolved
        
        return {
            "category": "required_fields",
            "entity": entity,
            "rule_data": rule_data,
        }

    def _parse_attendance_rule(self, description: str) -> Dict[str, Any]:
        """Parse attendance rule from description."""
        description_lower = description.lower()
        
        # Extract metric type
        metric = "absence_rate_30d"
        if "consecutive" in description_lower:
            metric = "consecutive_absences"
        elif "tardy" in description_lower:
            metric = "tardy_rate"
        elif "partial" in description_lower:
            metric = "partial_attendance"
        
        # Extract thresholds
        thresholds = {}
        
        # Look for percentage thresholds
        percent_match = re.search(r"(\d+)%", description)
        if percent_match:
            value = float(percent_match.group(1)) / 100.0
            thresholds["warning"] = value * 0.8  # 80% of stated value for warning
            thresholds["critical"] = value
        
        # Look for count thresholds
        count_match = re.search(r"(\d+)\s+(absence|absent|tardy)", description_lower)
        if count_match:
            value = int(count_match.group(1))
            thresholds["warning"] = value * 0.7
            thresholds["critical"] = value
        
        if not thresholds:
            thresholds = {"warning": 0.15, "critical": 0.25}
        
        return {
            "category": "attendance_rules",
            "entity": None,
            "rule_data": {
                "thresholds": {
                    metric: thresholds,
                },
            },
        }
