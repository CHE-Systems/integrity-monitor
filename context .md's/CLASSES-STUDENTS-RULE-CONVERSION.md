# Classes->Students Relationship Rule Conversion

## Summary
Converted the "classes must have at least one enrolled student" relationship rule to a required field rule, following the same pattern used for other relationship rules (e.g., parents->students).

## What Was Done

1. **Created conversion script**: `backend/scripts/convert_classes_students_rule.py`
   - Finds the classes->students relationship rule in Firestore
   - Converts it to a required field rule checking the "Student" field
   - Deletes the original relationship rule

2. **Field mapping**:
   - Relationship rule target: `students`
   - Required field name: `Student` (matches Airtable field name)
   - Field ID: `fld7zGFTadVlvSitj` (from Airtable schema)

## How It Works

The required field check (`backend/checks/required_fields.py`) already handles link fields correctly:
- Link fields in Airtable return lists of record IDs
- The `_is_valid_value()` function checks if lists are non-empty (line 228-229)
- This means the converted rule will properly validate that the "Student" field has at least one linked student

## Next Steps

1. **Run the conversion script** (when network connectivity is available):
   ```bash
   python backend/scripts/convert_classes_students_rule.py
   ```

2. **Verify the conversion**:
   - Check Firestore: `rules/required_fields/classes/required_field_rule.classes.student` should exist
   - Check Firestore: `rules/relationships/classes/students` (or similar) should be deleted

3. **Test the rule**:
   - Run a scan and verify that classes without students are flagged
   - The rule should appear in the Rules page under Classes > Required Fields

## Technical Details

- **Rule ID format**: `required_field_rule.classes.student`
- **Field reference**: Uses field name "Student" (will be resolved to field ID via schema)
- **Severity**: `warning` (can be adjusted if needed)
- **Message**: Preserves the original relationship rule message, or defaults to "Classes must have at least one enrolled student."

## Related Files

- `backend/scripts/convert_classes_students_rule.py` - Conversion script
- `backend/checks/required_fields.py` - Required field validation logic
- `backend/services/rules_service.py` - Rules loading service
- `backend/config/table_mapping.yaml` - Entity mapping (includes "classes")
