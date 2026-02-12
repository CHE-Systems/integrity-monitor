# Raw JSON Editor Added to Rule Editor ✅

## What Was Added

Added a **Raw JSON editor** tab to the Rule Editor modal that allows direct editing of the complete rule definition as JSON.

## Features

### 1. Two Edit Modes
- **Form Editor** (default): Traditional form-based editing with field-specific inputs
- **Raw JSON**: Direct JSON editing for advanced users

### 2. Tab Switching
- Tabs at the top of the modal to switch between Form and JSON modes
- Data syncs between modes automatically
- Changes in form mode update the JSON
- Valid JSON changes update the form fields

### 3. JSON Editor Features
- **Large textarea** (20 rows) with monospace font for easy editing
- **Live validation**: Shows error if JSON is invalid
- **Auto-sync**: Valid JSON parses and updates the internal rule data
- **Helpful placeholder**: Shows example JSON structure
- **Clear error messages**: "Invalid JSON format" or "Rule must be a JSON object"

### 4. Use Cases

**Example: Fixing Field Names**
If a required field rule points to "students" but the actual Airtable field is "Student":

1. Open the rule in edit mode
2. Click "Raw JSON" tab
3. Change `"field": "students"` to `"field": "Student"`
4. Click Save

The JSON editor allows editing ANY field:
- `field` - the actual Airtable field name
- `field_name` - the display name for the rule
- `message` - the error message
- `severity` - warning, info, critical
- `rule_id` - the rule identifier
- Any other custom fields

## Files Modified

**Frontend:**
- [frontend/src/components/RuleEditor.tsx](frontend/src/components/RuleEditor.tsx)
  - Added `editMode` state ("form" | "json")
  - Added `rawJson` state for JSON content
  - Added tab switcher UI
  - Added JSON validation in `validate()` function
  - Updated `handleSave()` to handle JSON mode
  - Added JSON editor textarea with live parsing

## How It Works

### Data Flow

**Form → JSON:**
When switching from Form to JSON:
```typescript
setRawJson(JSON.stringify(ruleData, null, 2));
```

**JSON → Form:**
When editing JSON:
```typescript
const parsed = JSON.parse(value);
setRuleData(parsed);
```

### Validation

**JSON Mode:**
- Checks if JSON is valid
- Checks if it's an object (not array, string, etc.)
- Shows inline error messages

**Form Mode:**
- Field-specific validation (existing behavior)
- Required field checks
- JSON field validation for conditions/thresholds

### Save Behavior

**JSON Mode:**
```typescript
const parsed = JSON.parse(rawJson);
onSave(parsed, selectedCategory, selectedEntity);
```

**Form Mode:**
```typescript
onSave(ruleData, selectedCategory, selectedEntity);
```

## Example Use Cases

### 1. Fix Field Name
**Problem**: Rule references "students" but Airtable field is "Student"

**Solution**:
```json
{
  "rule_id": "required_field_rule.parents.students",
  "entity": "parents",
  "field": "Student",  // Changed from "students"
  "message": "Parents must have at least one student linked.",
  "severity": "warning",
  "enabled": true
}
```

### 2. Add Custom Metadata
**Before**:
```json
{
  "rule_id": "dup.contractor.email_phone",
  "description": "Email or phone matches",
  "conditions": [...]
}
```

**After**:
```json
{
  "rule_id": "dup.contractor.email_phone",
  "description": "Email or phone matches",
  "conditions": [...],
  "custom_note": "Updated 2026-01-02",
  "priority": "high"
}
```

### 3. Bulk Field Changes
Instead of clicking through forms, edit multiple fields at once:
```json
{
  "field": "Student",
  "field_name": "Student Link",
  "message": "Every parent must have at least one student linked.",
  "severity": "critical"
}
```

## UI/UX

### Tab Design
- Clean tabs with blue underline for active tab
- Smooth transitions between modes
- Data syncs automatically when switching

### JSON Editor
- Monospace font for code readability
- Adequate height (20 rows) for editing
- Clear validation errors
- Helpful placeholder text

### User Guidance
Help text below JSON editor:
> "Edit the complete rule definition as JSON. You can change any field including field names, IDs, and messages."

## Testing

To test the feature:
1. Go to Rules Management page
2. Click any rule to edit
3. Click "Raw JSON" tab at the top
4. Edit the JSON (e.g., change a field name)
5. Click Save
6. Verify the rule updated correctly

## Benefits

✅ **Flexibility**: Edit any field, not just form-exposed ones
✅ **Speed**: Faster for power users who know JSON
✅ **Completeness**: Can see and edit entire rule structure
✅ **Debugging**: Easy to copy/paste rules for troubleshooting
✅ **Bulk edits**: Change multiple fields at once

---

**Feature added**: 2026-01-02
**Component**: RuleEditor.tsx
**Modes**: Form Editor + Raw JSON Editor
