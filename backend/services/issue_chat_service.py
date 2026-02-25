"""AI-powered chat service for answering questions about data integrity issues.

Uses OpenAI's GPT model with tool calling to lazily fetch Airtable record
details only when the user asks about record-level attributes (campus, school
year, grade, etc.).
"""

from __future__ import annotations

import json
import logging
import os
from collections import Counter
from typing import Any, Dict, List, Optional

from ..utils.secrets import get_secret

logger = logging.getLogger(__name__)

# Fields to skip when building field distributions (internal/system fields)
SKIP_FIELD_PATTERNS = [
    "zapier", "rollup", "lookup", "(from ", "record id", "today's date",
    "created", "modified", "copy", "autonumber", "auto number",
]

# Maximum records to fetch per entity for field distributions
MAX_RECORDS_PER_BATCH = 50
MAX_TOTAL_RECORDS = 200

# Maximum rounds of tool calling to prevent infinite loops
MAX_TOOL_ROUNDS = 3

# ---------------------------------------------------------------------------
# Tool definitions for GPT
# ---------------------------------------------------------------------------

GET_ENTITY_FIELDS_TOOL = {
    "type": "function",
    "function": {
        "name": "get_entity_fields",
        "description": (
            "Look up the Airtable field names and types for a given entity/table. "
            "Call this FIRST when you need to understand what fields exist before "
            "fetching record data — especially when the user asks about specific "
            "attributes like school year, campus, grade, enrollment status, etc. "
            "This helps you interpret the record data correctly."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "entity": {
                    "type": "string",
                    "description": (
                        "The entity/table to look up fields for "
                        "(e.g., 'students', 'parents', 'contractors', 'classes', 'absent')"
                    ),
                },
            },
            "required": ["entity"],
        },
    },
}

FETCH_RECORDS_TOOL = {
    "type": "function",
    "function": {
        "name": "fetch_record_details",
        "description": (
            "Fetch field-level data (like campus, school year, grade, status, etc.) "
            "for records in a specific entity. Use this when the user asks about "
            "record attributes that are not available in the issue summary. "
            "Returns distributions of field values across all matching records. "
            "IMPORTANT: Call get_entity_fields first if you are unsure which field "
            "names to look for in the results."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "entity": {
                    "type": "string",
                    "description": (
                        "The entity/table to fetch records from "
                        "(e.g., 'students', 'parents', 'contractors', 'classes', 'absent')"
                    ),
                },
            },
            "required": ["entity"],
        },
    },
}

ALL_TOOLS = [GET_ENTITY_FIELDS_TOOL, FETCH_RECORDS_TOOL]

SYSTEM_PROMPT = """You are a data analyst assistant for a school data integrity monitoring system called CHE (Community of Hope Education). You are given a summary of data integrity issues found during a scan of school records stored in Airtable.

The issue data includes:
- entity: which data table (students, parents, contractors, classes, absent)
- issue_type: duplicate, missing_field, missing_link, attendance, orphaned_link
- severity: critical, warning, info
- rule_id: the specific check that flagged the issue (e.g., dup.students.name_dob, req.students.email)
- description: human-readable description of what's wrong
- metadata: additional context (field names, related records, etc.)
- status: open, resolved, closed

You have access to two tools:

1. **get_entity_fields** — Returns the Airtable field names and types for a table. Call this FIRST when the user asks about record attributes (school year, campus, grade, enrollment, etc.) so you know exactly which field names to look for. This prevents misinterpreting the data.

2. **fetch_record_details** — Fetches actual record data and returns field value distributions. Use this when the user asks about record-level attributes not in the issue summary.

IMPORTANT WORKFLOW: When the user asks about specific record attributes:
1. First call get_entity_fields to learn the exact field names
2. Then call fetch_record_details to get the data
3. Use the field names from step 1 to correctly interpret the distributions from step 2

Do NOT call tools for questions that can be answered from the issue summary alone.

Answer the user's questions concisely and accurately. Use specific numbers from the data. If you can't determine something from available data, say so.

FORMATTING RULES:
- When presenting breakdowns, comparisons, or lists of items with associated values (counts, percentages, statuses), ALWAYS use a markdown table (| Header | Header | ... |) instead of bullet lists.
- Use bold for emphasis in headings and key takeaways.
- Use bullet lists only for short qualitative notes or recommendations, not for data breakdowns.
- Keep tables compact — use short column headers.

ISSUE DATA SUMMARY:
{issue_context}"""


class IssueChatService:
    """Service for AI-powered chat about data integrity issues."""

    def __init__(self):
        """Initialize with OpenAI API key."""
        self.openai_api_key = get_secret("OPENAI_API_KEY")
        self.openai_enabled = bool(self.openai_api_key)
        if not self.openai_enabled:
            logger.warning("OpenAI API key not available — issue chat will not work")

    def chat(
        self,
        messages: List[Dict[str, str]],
        issue_context: str,
        record_ids_by_entity: Dict[str, List[str]],
    ) -> str:
        """Process a chat message about issues and return AI response.

        Args:
            messages: Conversation history [{role, content}]
            issue_context: JSON summary of issues from buildIssueSummary()
            record_ids_by_entity: {entity: [record_ids]} for lazy record fetching

        Returns:
            AI response text
        """
        if not self.openai_enabled:
            return "AI chat is not available. The OpenAI API key is not configured."

        try:
            import openai

            client = openai.OpenAI(api_key=self.openai_api_key)

            # Build the full messages array with system prompt
            system_message = SYSTEM_PROMPT.format(issue_context=issue_context)
            full_messages = [{"role": "system", "content": system_message}]
            full_messages.extend(messages)

            # Tool-calling loop: GPT may call multiple tools across multiple rounds
            # (e.g., get_entity_fields first, then fetch_record_details)
            for round_num in range(MAX_TOOL_ROUNDS):
                response = client.chat.completions.create(
                    model="gpt-4o-mini",
                    messages=full_messages,
                    tools=ALL_TOOLS,
                    tool_choice="auto",
                    temperature=0.4,
                )

                choice = response.choices[0]

                # If GPT wants to call tools, handle them and loop
                if choice.finish_reason == "tool_calls" and choice.message.tool_calls:
                    full_messages.append(choice.message.model_dump())

                    for tool_call in choice.message.tool_calls:
                        tool_result = self._execute_tool(
                            tool_call, record_ids_by_entity
                        )
                        full_messages.append({
                            "role": "tool",
                            "tool_call_id": tool_call.id,
                            "content": tool_result,
                        })

                    # Continue the loop so GPT can call more tools or respond
                    continue

                # GPT finished with a text response
                return choice.message.content or "I wasn't able to generate a response."

            # If we exhausted rounds, do one final call without tools
            response = client.chat.completions.create(
                model="gpt-4o-mini",
                messages=full_messages,
                temperature=0.4,
            )
            return response.choices[0].message.content or "I wasn't able to generate a response."

        except ImportError:
            logger.warning("openai package not installed")
            return "AI chat is not available. The openai package is not installed."
        except Exception as exc:
            logger.error(f"Issue chat error: {exc}", exc_info=True)
            return "Sorry, I encountered an error processing your question. Please try again."

    # ------------------------------------------------------------------
    # Tool dispatch
    # ------------------------------------------------------------------

    def _execute_tool(
        self,
        tool_call: Any,
        record_ids_by_entity: Dict[str, List[str]],
    ) -> str:
        """Execute a single tool call and return the result as JSON string."""
        name = tool_call.function.name
        try:
            args = json.loads(tool_call.function.arguments)
        except json.JSONDecodeError:
            return json.dumps({"error": f"Invalid arguments for tool {name}"})

        try:
            if name == "get_entity_fields":
                return self._get_entity_fields(args.get("entity", ""))

            if name == "fetch_record_details":
                entity = args.get("entity", "")
                record_ids = self._resolve_entity_record_ids(
                    entity, record_ids_by_entity
                )
                if record_ids is None:
                    return json.dumps({
                        "error": f"No record IDs available for entity '{entity}'. "
                                 f"Available entities: {list(record_ids_by_entity.keys())}"
                    })
                return self._fetch_and_summarize_records(
                    record_ids["entity"], record_ids["ids"]
                )

            return json.dumps({"error": f"Unknown tool: {name}"})

        except Exception as exc:
            logger.error(f"Tool call error ({name}): {exc}", exc_info=True)
            return json.dumps({"error": f"Failed to execute {name}: {str(exc)}"})

    def _resolve_entity_record_ids(
        self,
        entity: str,
        record_ids_by_entity: Dict[str, List[str]],
    ) -> Optional[Dict[str, Any]]:
        """Resolve entity name to record IDs, handling singular/plural variants.

        Returns:
            {"entity": resolved_key, "ids": [record_ids]} or None
        """
        record_ids = record_ids_by_entity.get(entity)
        if record_ids:
            return {"entity": entity, "ids": record_ids}

        entity_lower = entity.lower().strip()
        for key, ids in record_ids_by_entity.items():
            key_lower = key.lower().strip()
            if (
                key_lower == entity_lower
                or key_lower == entity_lower.rstrip("s")
                or key_lower + "s" == entity_lower
                or key_lower.rstrip("s") == entity_lower.rstrip("s")
                or entity_lower in key_lower
                or key_lower in entity_lower
            ):
                return {"entity": key, "ids": ids}

        return None

    # ------------------------------------------------------------------
    # get_entity_fields tool
    # ------------------------------------------------------------------

    def _get_entity_fields(self, entity: str) -> str:
        """Return field names and types for a given entity from the schema.

        Gives GPT the knowledge to correctly interpret field distributions.
        """
        try:
            from ..services.airtable_schema_service import schema_service

            schema_data = schema_service.load()
            table_info = self._resolve_table_info(entity, schema_data)

            if not table_info:
                available = [t.get("name", "") for t in schema_data.get("tables", [])]
                return json.dumps({
                    "error": f"Table not found for entity: {entity}",
                    "available_tables": available,
                })

            # Build a compact list of field name + type, excluding system fields
            fields_summary = []
            select_options: Dict[str, List[str]] = {}

            for field in table_info.get("fields", []):
                field_name = field.get("name", "")
                field_type = field.get("type", "unknown")

                if self._should_skip_field(field_name):
                    continue

                fields_summary.append({
                    "name": field_name,
                    "type": field_type,
                })

                # Include select/multiselect option values — these are critical
                # for GPT to understand what values to look for (e.g., school year values)
                options = field.get("options") or {}
                choices = options.get("choices")
                if choices and isinstance(choices, list):
                    option_names = [
                        c.get("name", "") for c in choices[:30] if c.get("name")
                    ]
                    if option_names:
                        select_options[field_name] = option_names

            result = {
                "entity": entity,
                "table_name": table_info.get("name"),
                "total_fields": len(fields_summary),
                "fields": fields_summary,
            }

            if select_options:
                result["select_field_values"] = select_options

            return json.dumps(result)

        except Exception as exc:
            logger.error(f"Failed to get entity fields: {exc}", exc_info=True)
            return json.dumps({"error": f"Failed to get fields: {str(exc)}"})

    def _resolve_table_info(self, entity: str, schema_data: Dict) -> Optional[Dict]:
        """Resolve entity name to the full table dict from the schema."""
        entity_lower = entity.lower().strip()
        entity_mapping = {
            "student": "students",
            "parent": "parents",
            "contractor": "contractors",
            "class": "classes",
        }
        normalized = entity_mapping.get(entity_lower, entity_lower)

        for table in schema_data.get("tables", []):
            table_name_lower = table.get("name", "").lower().strip()
            table_name_normalized = table_name_lower.replace(" ", "_")
            entity_as_spaces = normalized.replace("_", " ")

            if (
                table_name_lower == normalized
                or table_name_lower == entity_lower
                or table_name_lower == entity_as_spaces
                or table_name_normalized == normalized
                or normalized in table_name_lower
                or entity_as_spaces in table_name_lower
            ):
                return table

        return None

    # ------------------------------------------------------------------
    # fetch_record_details tool
    # ------------------------------------------------------------------

    def _fetch_and_summarize_records(
        self, entity: str, record_ids: List[str]
    ) -> str:
        """Fetch Airtable records and build compact field distributions."""
        try:
            from pyairtable import Api
            from ..services.airtable_schema_service import schema_service

            schema_data = schema_service.load()
            base_id = schema_data.get("baseId")

            if not base_id:
                return json.dumps({"error": "Base ID not found in schema"})

            table_id = self._resolve_table_id(entity, schema_data)
            if not table_id:
                return json.dumps({"error": f"Table not found for entity: {entity}"})

            pat = get_secret("AIRTABLE_PAT")
            if not pat:
                return json.dumps({"error": "Airtable API key not configured"})

            api = Api(pat)
            table = api.table(base_id, table_id)

            # Fetch records in batches
            all_records = []
            ids_to_fetch = record_ids[:MAX_TOTAL_RECORDS]

            for i in range(0, len(ids_to_fetch), MAX_RECORDS_PER_BATCH):
                batch_ids = ids_to_fetch[i : i + MAX_RECORDS_PER_BATCH]
                record_conditions = [f"RECORD_ID()='{rid}'" for rid in batch_ids]
                formula = f"OR({','.join(record_conditions)})"

                fetched = list(table.all(formula=formula))
                all_records.extend(fetched)

            logger.info(
                "Fetched Airtable records for chat",
                extra={"entity": entity, "requested": len(ids_to_fetch), "fetched": len(all_records)},
            )

            distributions = self._build_field_distributions(all_records)

            return json.dumps({
                "entity": entity,
                "total_records_fetched": len(all_records),
                "total_records_available": len(record_ids),
                "field_distributions": distributions,
            })

        except Exception as exc:
            logger.error(f"Failed to fetch records for chat: {exc}", exc_info=True)
            return json.dumps({"error": f"Failed to fetch records: {str(exc)}"})

    def _resolve_table_id(self, entity: str, schema_data: Dict) -> Optional[str]:
        """Resolve Airtable table ID from entity name."""
        table_info = self._resolve_table_info(entity, schema_data)
        if table_info:
            return table_info.get("id")

        # Fallback to environment variable
        entity_lower = entity.lower().strip()
        entity_mapping = {
            "student": "students",
            "parent": "parents",
            "contractor": "contractors",
            "class": "classes",
        }
        normalized = entity_mapping.get(entity_lower, entity_lower)
        env_key = f"AIRTABLE_{normalized.upper()}_TABLE"
        return os.getenv(env_key) or os.getenv(f"AT_{normalized.upper()}_TABLE")

    # ------------------------------------------------------------------
    # Field distribution helpers
    # ------------------------------------------------------------------

    def _build_field_distributions(
        self, records: List[Dict[str, Any]]
    ) -> Dict[str, Dict[str, int]]:
        """Build value distributions for each field across all records."""
        if not records:
            return {}

        field_counters: Dict[str, Counter] = {}

        for record in records:
            fields = record.get("fields", {})
            for field_name, value in fields.items():
                if self._should_skip_field(field_name):
                    continue

                display_value = self._normalize_field_value(value)
                if display_value is None:
                    continue

                if field_name not in field_counters:
                    field_counters[field_name] = Counter()
                field_counters[field_name][display_value] += 1

        distributions = {}
        for field_name, counter in field_counters.items():
            unique_ratio = len(counter) / len(records) if records else 1
            if unique_ratio > 0.8 and len(counter) > 10:
                continue

            top_values = dict(counter.most_common(30))
            if top_values:
                distributions[field_name] = top_values

        return distributions

    def _should_skip_field(self, field_name: str) -> bool:
        """Check if a field should be excluded from distributions."""
        lower = field_name.lower()
        for pattern in SKIP_FIELD_PATTERNS:
            if pattern in lower:
                return True
        if lower.endswith(" id") and "entry" not in lower:
            return True
        return False

    def _normalize_field_value(self, value: Any) -> Optional[str]:
        """Convert a field value to a string for counting, or None to skip."""
        if value is None or value == "":
            return None

        if isinstance(value, str):
            if len(value) > 100:
                return None
            if value.startswith("rec") and len(value) == 17:
                return None
            return value

        if isinstance(value, bool):
            return "Yes" if value else "No"

        if isinstance(value, (int, float)):
            return str(value)

        if isinstance(value, list):
            if not value:
                return None
            if isinstance(value[0], str) and value[0].startswith("rec"):
                return f"{len(value)} linked"
            if all(isinstance(v, str) for v in value) and len(value) <= 3:
                return ", ".join(value)
            return f"{len(value)} items"

        if isinstance(value, dict):
            return None

        return str(value)
