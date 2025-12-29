# Rules Implementation Guide

## Overview

This guide covers everything you need to know to implement and maintain integrity rules in the CHE Data Integrity Monitor system. Rules validate data quality across Airtable tables by checking for missing fields, duplicates, relationship consistency, and attendance patterns.

---

## Table of Contents

1. [Field Reference Format](#field-reference-format)
2. [Airtable Schema Snapshot](#airtable-schema-snapshot)
3. [Rule Storage (Firestore)](#rule-storage-firestore)
4. [Best Practices](#best-practices)
5. [Code-Level Behavior](#code-level-behavior)
6. [Configuration Checklist](#configuration-checklist)
7. [Testing Rules](#testing-rules)
8. [Troubleshooting](#troubleshooting)
9. [Rule Categories](#rule-categories)

---

## Field Reference Format

### Supported Formats

Rules can reference Airtable fields using **either** format:

1. **Airtable Field IDs**: `flddCJDACjAsP1ltS` (starts with "fld", 14+ characters)
2. **Field Names**: `"Email"`, `"Cell phone"`, `"Contractor/Vol"`

The system automatically resolves both formats via `backend/utils/records.py:get_field()`.

### Examples

```yaml
# Using Field ID (recommended for production)
missing_key_data:
  - field: flddCJDACjAsP1ltS
    rule_id: "required_field.contractors.email"
    message: "Email is required."
    severity: warning

# Using Field Name (human-readable)
missing_key_data:
  - field: Email
    rule_id: "required_field.contractors.email"
    message: "Email is required."
    severity: warning
```

### Why Both Formats Work

The system uses `backend/config/airtable_schema.json` to map between field IDs and names, allowing rules to work regardless of how Airtable returns record data (by ID or by name).

---

## Airtable Schema Snapshot

### Critical Dependency

The `backend/config/airtable_schema.json` file is **essential** for field resolution. It contains the mapping between:

- Field IDs (`fld...`) ↔ Field Names (`"Email"`, etc.)
- Table IDs ↔ Table Names
- Field metadata (types, options, etc.)

### When to Update

Update the schema snapshot when:

- ✅ Adding new fields to Airtable tables
- ✅ Renaming fields in Airtable
- ✅ Adding new tables
- ✅ Before creating rules that reference new fields
- ✅ After any Airtable schema changes

### How to Update

Run the schema snapshot script:

```bash
# From project root or backend/ directory
cd backend
python -m backend.scripts.airtable_records_snapshot
```

This script:

1. Connects to your Airtable base using `AIRTABLE_PAT`
2. Fetches all tables and their field definitions
3. Builds the ID↔name mapping
4. Writes to `backend/config/airtable_schema.json`

### Schema File Location

- **Backend**: `backend/config/airtable_schema.json`
- **Frontend**: `frontend/public/airtable-schema.json` (optional copy)

---

## Rule Storage (Firestore)

### Collection Structure

Rules are stored in Firestore under the `rules/` collection:

```
rules/
├── duplicates/
│   └── {entity}/
│       └── {rule_id}
├── relationships/
│   └── {entity}/
│       └── {relationship_key}
├── required_fields/
│   └── {entity}/
│       └── {rule_id}
└── attendance/
    └── thresholds/
```

### Required Fields Rule Format

```json
{
  "field": "flddCJDACjAsP1ltS", // Field ID (recommended)
  "rule_id": "required_field.contractors.email",
  "entity": "contractors",
  "message": "Email is required.",
  "severity": "warning",
  "alternate_fields": null,
  "condition_field": null,
  "condition_value": null,
  "source": "user",
  "enabled": true,
  "created_at": "2025-12-26T22:00:00Z",
  "updated_at": "2025-12-26T22:00:00Z"
}
```

**Field Property**: Can be either:

- Field ID: `"flddCJDACjAsP1ltS"` ✅
- Field Name: `"Email"` ✅

### Relationship Rule Format

```json
{
  "target": "parents",
  "source_entity": "students",
  "message": "Students need at least one active parent/guardian.",
  "min_links": 1,
  "max_links": null,
  "require_active": true,
  "condition_field": null,
  "condition_value": null
}
```

### Duplicate Rule Format

```json
{
  "rule_id": "dup.contractor.email_phone",
  "entity": "contractors",
  "description": "Email or phone matches plus name similarity.",
  "severity": "likely",
  "conditions": [
    {
      "type": "exact_match",
      "field": "email"
    },
    {
      "type": "similarity",
      "field": "legal_name",
      "similarity": 0.92
    }
  ]
}
```

---

## Best Practices

### Field Reference Guidelines

**Use Field IDs when:**

- ✅ Creating production rules (more resilient to name changes)
- ✅ Storing rules in Firestore (stable identifiers)
- ✅ Rules need to survive field renames

**Use Field Names when:**

- ✅ Writing human-readable configs (YAML, documentation)
- ✅ Quick testing/debugging
- ✅ Rules are temporary or experimental

### Rule Creation Checklist

Before creating/updating rules:

- [ ] `airtable_schema.json` is current (run snapshot script if needed)
- [ ] Field exists in the target Airtable table
- [ ] Rule `field` value matches either:
  - Exact Airtable field ID (e.g., `flddCJDACjAsP1ltS`)
  - Exact Airtable field name (e.g., `"Email"`)
- [ ] `rule_id` follows naming convention: `{category}.{entity}.{identifier}`
- [ ] `severity` is one of: `"info"`, `"warning"`, `"critical"`

### Naming Conventions

**Rule IDs:**

- Required Fields: `required_field.{entity}.{field_name}`
- Duplicates: `dup.{entity}.{description}`
- Relationships: `link.{entity}.{relationship_key}`

**Examples:**

- `required_field.contractors.email`
- `dup.contractor.email_phone`
- `link.students.parents`

### When Adding New Fields to Airtable

1. **Add the field** in Airtable UI
2. **Run schema snapshot**: `python -m backend.scripts.airtable_records_snapshot`
3. **Verify** the field appears in `backend/config/airtable_schema.json`
4. **Create rules** referencing the new field (ID or name)

---

## Code-Level Behavior

### Field Resolution Logic

The `get_field()` function in `backend/utils/records.py` handles field resolution:

```python
def get_field(fields: Dict[str, Any], key: str) -> Any:
    """Resolves field references using schema snapshot."""

    # 1. If key is field ID (fld...)
    if key.startswith("fld") and len(key) >= 14:
        # Try direct lookup
        if key in fields:
            return fields[key]
        # Resolve ID → name via schema, then lookup
        field_name = id_to_name.get(key)
        if field_name and field_name in fields:
            return fields[field_name]
        return None

    # 2. If key is field name
    # Try exact match and variants (underscore↔space, case-insensitive)
    candidates = {key, key.replace("_", " "), key.title(), ...}
    for candidate in candidates:
        if candidate in fields:
            return fields[candidate]

    # 3. Fallback: resolve name → IDs via schema
    # Then try lookup by ID or resolved name
    ...
```

### Resolution Flow

1. **Field ID provided**:

   - Direct lookup in `fields` dict
   - If not found, resolve ID → name via schema
   - Lookup by resolved name

2. **Field name provided**:
   - Try exact match and name variants
   - If not found, resolve name → IDs via schema
   - Try lookup by resolved IDs or names

### What This Means

- ✅ Rules with field IDs work even if records are name-keyed
- ✅ Rules with field names work even if records are ID-keyed
- ✅ Both formats supported simultaneously
- ✅ System handles Airtable API response format changes

---

## Configuration Checklist

### Before Creating Rules

- [ ] **Schema snapshot is current**

  ```bash
  cd backend
  python -m backend.scripts.airtable_records_snapshot
  ```

- [ ] **Field exists in target table**

  - Check `backend/config/airtable_schema.json`
  - Or verify in Airtable UI

- [ ] **Field reference format chosen**

  - Field ID (recommended): `flddCJDACjAsP1ltS`
  - Field Name: `"Email"`

- [ ] **Rule structure validated**
  - Required fields present
  - `rule_id` follows convention
  - `severity` is valid

### When Schema Changes

1. **Update Airtable** (add/rename fields)
2. **Run snapshot script** (update `airtable_schema.json`)
3. **Verify mapping** (check schema file)
4. **Update/create rules** (reference new fields)

---

## Testing Rules

### Manual Testing

Test field resolution:

```python
from backend.utils.records import get_field

# Simulate a record (as returned by Airtable)
fields = {
    "Email": "test@example.com",
    "Cell phone": "555-1234",
    "Contractor/Vol": "Contractor"
}

# Both should work:
assert get_field(fields, "flddCJDACjAsP1ltS") == "test@example.com"  # ID
assert get_field(fields, "Email") == "test@example.com"  # Name
```

### Integration Testing

1. **Create test rule** in Firestore
2. **Run scan** on target entity:
   ```bash
   curl -X POST "http://localhost:8000/integrity/run?trigger=manual&entities=contractors"
   ```
3. **Check results**:
   - Issue count should match expectations
   - Not `records × rules` (indicates resolution failure)
   - Logs show field resolution success

### Validation Checks

- ✅ Issue count is reasonable (not every record × every rule)
- ✅ Only records with actual violations create issues
- ✅ Empty/null/blank values correctly flagged
- ✅ Condition fields work as expected

---

## Troubleshooting

### Rules Fire for Every Record

**Symptom**: Issue count = `number_of_records × number_of_rules`

**Causes**:

1. Schema snapshot is outdated
2. Field ID/name doesn't exist in schema
3. Field resolution returning `None` for all records

**Solutions**:

1. Update schema snapshot:
   ```bash
   python -m backend.scripts.airtable_records_snapshot
   ```
2. Verify field exists in `backend/config/airtable_schema.json`
3. Check logs for `get_field()` returning `None`
4. Verify field reference format (ID vs name)

### Rules Never Fire

**Symptom**: Issue count = 0, but violations exist

**Causes**:

1. Field values not actually empty (whitespace, etc.)
2. Condition field/value filtering out records
3. Entity name mismatch

**Solutions**:

1. Check field values in Airtable (not just visually empty)
2. Verify `condition_field`/`condition_value` logic
3. Ensure entity name matches table configuration
4. Test with simpler rule (no conditions)

### Field Resolution Fails

**Symptom**: `get_field()` returns `None` for valid fields

**Causes**:

1. Schema snapshot missing or outdated
2. Field name/ID typo in rule
3. Case sensitivity issues

**Solutions**:

1. Verify schema file exists: `backend/config/airtable_schema.json`
2. Check field name matches exactly (case-sensitive)
3. Use field ID instead of name (more stable)
4. Check logs for resolution errors

### Schema Snapshot Errors

**Symptom**: Snapshot script fails

**Causes**:

1. `AIRTABLE_PAT` not set or invalid
2. Network/API issues
3. Base/table access permissions

**Solutions**:

1. Verify `AIRTABLE_PAT` environment variable
2. Check Airtable API status
3. Verify base/table access in Airtable
4. Check API rate limits

---

## Rule Categories

### 1. Required Fields

**Purpose**: Ensure critical fields are populated

**Location**: `rules/required_fields/{entity}/{rule_id}`

**Fields**:

- `field`: Field ID or name (required)
- `rule_id`: Unique identifier (required)
- `message`: Error message (required)
- `severity`: `"info"` | `"warning"` | `"critical"`
- `alternate_fields`: Array of alternative fields
- `condition_field`: Conditional field name (optional)
- `condition_value`: Value for conditional check (optional)

**Example**:

```json
{
  "field": "flddCJDACjAsP1ltS",
  "rule_id": "required_field.contractors.email",
  "message": "Email is required.",
  "severity": "warning"
}
```

### 2. Relationships

**Purpose**: Validate links between entities

**Location**: `rules/relationships/{entity}/{relationship_key}`

**Fields**:

- `target`: Target entity name (required)
- `min_links`: Minimum required links
- `max_links`: Maximum allowed links
- `require_active`: Require linked records to be active
- `message`: Error message (required)

**Example**:

```json
{
  "target": "parents",
  "min_links": 1,
  "require_active": true,
  "message": "Students need at least one active parent."
}
```

### 3. Duplicates

**Purpose**: Detect duplicate records

**Location**: `rules/duplicates/{entity}/{rule_id}`

**Fields**:

- `rule_id`: Unique identifier (required)
- `description`: Human-readable description
- `severity`: `"likely"` | `"possible"`
- `conditions`: Array of matching conditions

**Example**:

```json
{
  "rule_id": "dup.contractor.email_phone",
  "description": "Email or phone matches plus name similarity.",
  "severity": "likely",
  "conditions": [
    { "type": "exact_match", "field": "email" },
    { "type": "similarity", "field": "legal_name", "similarity": 0.92 }
  ]
}
```

### 4. Attendance

**Purpose**: Monitor attendance patterns

**Location**: `rules/attendance/thresholds`

**Fields**:

- `onboarding_grace_days`: Days to ignore absences for new students
- `limited_schedule_threshold`: Minimum classes/week
- `thresholds`: Metric thresholds (info/warning/critical)

---

## Quick Reference

### Field Resolution

| Input Format     | Resolution Method                                       |
| ---------------- | ------------------------------------------------------- |
| `fld...` (ID)    | Direct lookup → ID→name via schema → name lookup        |
| `"Email"` (name) | Exact match → variants → name→ID via schema → ID lookup |

### Schema Snapshot

```bash
# Update schema
cd backend
python -m backend.scripts.airtable_records_snapshot

# Verify schema exists
ls backend/config/airtable_schema.json
```

### Rule Creation

1. Update schema snapshot (if needed)
2. Choose field reference format (ID recommended)
3. Create rule in Firestore via API or UI
4. Test with manual scan
5. Verify issue counts

### Common Field IDs (Contractors Example)

- Email: `flddCJDACjAsP1ltS`
- Cell phone: `fldWBnA5Xf6eQATOi`
- Contractor/Vol: `fldvkUuMlXw8vBvNQ`

**Note**: Field IDs are table-specific. Always verify in schema snapshot.

---

## Summary

### Key Takeaways

1. **Field References**: Use IDs (preferred) or names (both work)
2. **Schema Snapshot**: Keep `airtable_schema.json` current
3. **Rule Storage**: Firestore accepts both formats
4. **Code**: `get_field()` handles resolution automatically
5. **Testing**: Verify issue counts match expectations

### Critical Files

- `backend/config/airtable_schema.json` - Field ID↔name mapping
- `backend/utils/records.py` - Field resolution logic
- `backend/scripts/airtable_records_snapshot.py` - Schema update script
- Firestore `rules/` collections - Rule storage

### The Fix

The system now resolves field IDs to names (and vice versa) using the schema snapshot, ensuring rules work regardless of how Airtable returns record data. This prevents the "records × rules" issue where every record appeared to violate every rule.

---

## Conditional Check Execution

### Overview

The system supports conditional execution of different check types (duplicates, links, required_fields, attendance) based on user selection in the scan configuration. This allows users to run only the checks they need, improving performance and reducing noise.

### How It Works

1. **Frontend Configuration** - When a user configures a scan in `ScanConfigModal`, the modal builds an `effectiveChecks` object based on which rules are selected:

   ```typescript
   const effectiveChecks = {
     duplicates: hasDuplicateRules,
     links: hasRelationshipRules,
     required_fields: hasRequiredFieldRules,
     attendance: hasAttendanceRules,
   };
   ```

2. **Request Body** - The frontend sends `checks` as part of the `runConfig`:

   ```typescript
   const runConfig = {
     entities: [...],
     rules: {...},
     checks: effectiveChecks  // ← Must be included!
   };
   ```

3. **Backend Execution** - The backend's `IntegrityRunner` checks `run_config.checks` before executing each check type:
   ```python
   should_run_duplicates = True  # Default for backwards compatibility
   if hasattr(self, "_run_config") and self._run_config:
       checks = self._run_config.get("checks", {})
       if "duplicates" in checks:
           should_run_duplicates = bool(checks["duplicates"])
   ```

### Critical Implementation Details

**Frontend Requirements:**

- ✅ **Always include `checks` in `runConfig`** - Both `App.tsx` and `RunsPage.tsx` must include `config.checks` when building `runConfig`
- ✅ **Send `runConfig` directly as body** - FastAPI's `Body(default=None)` expects the value directly, not wrapped:

  ```typescript
  // ✅ Correct
  body: JSON.stringify(runConfig);

  // ❌ Wrong (creates double-nesting)
  body: JSON.stringify({ run_config: runConfig });
  ```

**Backend Requirements:**

- ✅ **Check for key existence** - Use `"duplicates" in checks` to distinguish between "key missing" (use default) and "key present with False" (respect False)
- ✅ **Default to True for backwards compatibility** - If `checks` is missing entirely, default to running all checks
- ✅ **Respect explicit False values** - If `checks.duplicates = False`, skip the duplicates check

### Common Issues

**Issue: Duplicates check runs even when not selected**

**Symptoms:**

- User selects only required field rules
- Duplicates check still executes
- Backend logs show `should_run_duplicates = True`

**Causes:**

1. **`checks` field not included in request** - Frontend builds `runConfig` but doesn't include `config.checks`
2. **Incorrect request body structure** - Wrapping `runConfig` in `{ run_config: ... }` causes FastAPI to receive wrong structure
3. **Multiple code paths** - Different pages (`App.tsx` vs `RunsPage.tsx`) may have different implementations

**Solutions:**

1. **Verify `checks` is included** - Check that both `App.tsx` and `RunsPage.tsx` include:

   ```typescript
   if (config.checks) {
     runConfig.checks = config.checks;
   }
   ```

2. **Verify request body structure** - Ensure `runConfig` is sent directly, not wrapped:

   ```typescript
   // ✅ Correct
   body: JSON.stringify(runConfig);

   // ❌ Wrong
   body: JSON.stringify({ run_config: runConfig });
   ```

3. **Check backend logs** - Look for `"has_checks": false` in debug logs, which indicates `checks` wasn't received

**Debugging Steps:**

1. Check browser console logs - Look for `"Config from modal"` to see what `checks` values are being sent
2. Check backend logs - Look for `"Duplicates check decision"` logs showing `has_checks` and `checks_duplicates_value`
3. Verify request body - Use browser DevTools Network tab to inspect the actual request payload
4. Check both code paths - Ensure both `App.tsx` and `RunsPage.tsx` are fixed

### Example: Fixing Missing Checks Field

**Before (Broken):**

```typescript
// App.tsx - Missing checks
const runConfig: any = {};
if (config.entities && config.entities.length > 0) {
  runConfig.entities = config.entities;
}
if (config.rules) {
  runConfig.rules = config.rules;
}
// ❌ config.checks is not included!
```

**After (Fixed):**

```typescript
// App.tsx - Includes checks
const runConfig: any = {};
if (config.entities && config.entities.length > 0) {
  runConfig.entities = config.entities;
}
if (config.rules) {
  runConfig.rules = config.rules;
}
if (config.checks) {
  // ✅ Added
  runConfig.checks = config.checks;
}
```

### Example: Fixing Request Body Structure

**Before (Broken):**

```typescript
// RunsPage.tsx - Wraps runConfig incorrectly
const requestBody: any = {};
if (Object.keys(runConfig).length > 0) {
  requestBody.run_config = runConfig; // ❌ Creates double-nesting
}
body: JSON.stringify(requestBody); // Sends { run_config: {...} }
```

**After (Fixed):**

```typescript
// RunsPage.tsx - Sends runConfig directly
const requestBody = Object.keys(runConfig).length > 0 ? runConfig : undefined;
body: requestBody ? JSON.stringify(requestBody) : undefined; // ✅ Sends {...} directly
```

### Best Practices

1. **Always include `checks`** - Even if all checks are `false`, include the `checks` object so the backend knows the user's intent
2. **Use consistent structure** - Both `App.tsx` and `RunsPage.tsx` should use the same request body structure
3. **Test both paths** - When fixing check execution, test scans from both the main page and the Runs page
4. **Log the decision** - Backend should log whether checks are enabled/disabled for debugging

---

## Additional Resources

- **Schema Spec**: `docs/prompt-1-schema-spec.md`
- **Firestore Rules Structure**: `docs/firestore-rules-structure.md`
- **Rules Service**: `backend/services/rules_service.py`
- **Field Resolution**: `backend/utils/records.py`
