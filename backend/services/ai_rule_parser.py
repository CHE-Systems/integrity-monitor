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
        """Parse required field rule from description."""
        description_lower = description.lower()
        
        # Extract field name
        field = None
        field_patterns = {
            "email": "email",
            "phone": "phone",
            "name": "name",
            "address": "address",
            "status": "status",
            "grade": "grade_level",
            "certification": "certification",
        }
        
        for pattern, field_name in field_patterns.items():
            if pattern in description_lower:
                field = field_name
                break
        
        if not field:
            # Try to extract from "missing X" or "X is required"
            missing_match = re.search(r"missing (\w+)", description_lower)
            if missing_match:
                field = missing_match.group(1)
            else:
                field = "field_name"
        
        # Try to look up field ID from schema snapshot (optional enhancement)
        field_id = None
        try:
            from pathlib import Path
            import json
            from ..utils.records import _normalize_name
            
            schema_path = Path(__file__).resolve().parent.parent / "config" / "airtable_schema.json"
            if schema_path.exists():
                with schema_path.open("r", encoding="utf-8") as f:
                    schema = json.load(f)
                
                # Map entity to table name
                entity_to_table = {
                    "contractors": "Contractors/Volunteers",
                    "students": "Students",
                    "parents": "Parents",
                    "classes": "Classes",
                }
                table_name = entity_to_table.get(entity, entity.title())
                
                # Find field by name
                normalized_field = _normalize_name(field)
                for table in schema.get("tables", []):
                    if table.get("name") == table_name or entity.lower() in table.get("name", "").lower():
                        for schema_field in table.get("fields", []):
                            schema_field_name = schema_field.get("name", "")
                            if (_normalize_name(schema_field_name) == normalized_field or
                                schema_field_name.lower() == field.lower()):
                                field_id = schema_field.get("id")
                                # Update field to exact name from schema
                                field = schema_field_name
                                break
                        if field_id:
                            break
        except Exception as exc:
            logger.debug(f"Could not look up field ID for {field}: {exc}")
        
        # Determine severity
        severity = "warning"
        if "critical" in description_lower or "must" in description_lower:
            severity = "critical"
        elif "info" in description_lower or "optional" in description_lower:
            severity = "info"
        
        rule_data = {
            "field": field,
            "message": description,
            "severity": severity,
        }
        
        # Include field_id if found
        if field_id:
            rule_data["field_id"] = field_id
        
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
