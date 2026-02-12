# Rules Loading Issue - Summary

## Problem Statement

Rules for `contractors` and `students` entities are not appearing in the scan configuration modal, even though:
- Rules exist and are visible in the Rules Management page
- The Rules Management page shows rules for "Contractors/Volunteers" and "Students"
- Only `parents` rules are being returned by the backend API

## Current Behavior

### Frontend Console Logs
When loading the scan configuration modal, the console shows:
```
[ScanConfigModal] No rules found for duplicates.students
[ScanConfigModal] No rules found for duplicates.contractors
[ScanConfigModal] No rules found for required_fields.students
[ScanConfigModal] No rules found for required_fields.contractors
```

The rules data structure shows only `parents` rules:
```json
{
  "duplicates": {
    "parents": { "likely": [], "possible": [...] }
  },
  "required_fields": {
    "parents": [...]
  }
}
```

### Backend Logs
Backend logs show:
```
Some expected entities have no rules
WARNING: Detected filter using positional arguments. Prefer using the 'filter' keyword argument instead.
```

## Root Cause Analysis

### What We Know
1. **Rules exist in Firestore** - Confirmed by Rules Management page displaying them
2. **Backend is querying correctly** - Code queries `rules/{category}/{entity}` paths
3. **Entity name mismatch suspected** - Rules might be stored under different entity names than expected
4. **Migration script found 0 rules** - Rules are NOT stored under singular names (`contractor`, `student`)

### Possible Issues
1. Rules stored under different entity names (e.g., "Contractors/Volunteers" instead of "contractors")
2. Rules have `enabled: false` or missing `enabled` field
3. Rules stored in different collection structure
4. Firestore permissions blocking access
5. Case sensitivity issues in entity names

## Changes Made

### 1. Fixed Issue Count Double-Counting (`backend/writers/firestore_writer.py`)
- **Problem**: Total issues count was double-counting (showing 2 instead of 1)
- **Fix**: Updated `_transform_summary_to_counts()` to only count severity-specific keys, not base keys
- **Status**: ✅ Fixed

### 2. Backend Entity Name Handling (`backend/services/rules_service.py`)
- **Added**: `_get_entity_variants()` method to handle singular/plural forms
- **Updated**: All three rule loading methods to query both singular and plural variants
- **Added**: Comprehensive logging to diagnose query issues
- **Status**: ✅ Implemented, but rules still not loading

### 3. Frontend Entity Name Matching (`frontend/src/components/ScanConfigModal.tsx`)
- **Added**: `findEntityInRules()` helper function to match entity names flexibly
- **Updated**: All rule lookups to use entity name matching
- **Added**: Debug logging to show actual entity names in rules structure
- **Status**: ✅ Implemented

### 4. Migration Script (`backend/scripts/migrate_entity_names.py`)
- **Created**: Script to migrate rules from singular to plural entity names
- **Result**: Found 0 rules to migrate (rules not stored under singular names)
- **Status**: ✅ Created but found no rules to migrate

### 5. Diagnostic Script (`backend/scripts/diagnose_rules.py`)
- **Created**: Script to list all rules collections in Firestore
- **Status**: ✅ Created (requires network access to run)

## Code Locations

### Key Files Modified
- `backend/services/rules_service.py` - Main rules loading logic
- `backend/writers/firestore_writer.py` - Issue counting fix
- `frontend/src/components/ScanConfigModal.tsx` - Frontend rule loading
- `backend/scripts/migrate_entity_names.py` - Migration script
- `backend/scripts/diagnose_rules.py` - Diagnostic script

### Key Methods
- `RulesService._load_duplicates_from_firestore()` - Loads duplicate rules
- `RulesService._load_relationships_from_firestore()` - Loads relationship rules
- `RulesService._load_required_fields_from_firestore()` - Loads required field rules
- `RulesService._get_entities_from_mapping()` - Gets entities from `table_mapping.yaml`
- `RulesService._get_entity_variants()` - Generates singular/plural variants

## Configuration Files

### Entity Mapping
- `backend/config/table_mapping.yaml` - Maps entity names to Airtable table names
  - Contains: `students`, `parents`, `contractors`, `absent`, `apps`, `tables`
- `frontend/src/config/entities.ts` - Frontend entity configuration
  - Contains: `ACTIVE_ENTITIES` array and `ENTITY_TABLE_MAPPING`

## Next Steps to Diagnose

### 1. Check Firebase Console
- Navigate to Firestore Database
- Check the actual collection paths where rules are stored
- Verify entity names used in collection paths
- Check if `enabled` field exists and its values

### 2. Check Backend Logs
When loading rules, look for:
- `"Querying Firestore for duplicates: rules/duplicates/{entity}"`
- `"Found X total document(s) in {collection_path}"`
- `"Found X disabled rule(s)"`
- `"✅ Loaded duplicate rules for {entity} from {variant}"`

### 3. Test API Directly
```bash
curl -H "Authorization: Bearer <token>" http://localhost:8000/rules
```
Check the response structure and which entities are returned.

### 4. Run Diagnostic Script
```bash
cd backend
python -m scripts.diagnose_rules
```
(Requires Firestore credentials configured)

### 5. Check Rules Management Page
- Inspect network requests when Rules Management page loads
- Check what entity names are used in the API response
- Compare with what scan config modal expects

## Expected Behavior

### Backend Should:
1. Query `rules/duplicates/{entity}` for each entity in `table_mapping.yaml`
2. Try both singular and plural variants (e.g., `contractor` and `contractors`)
3. Return rules normalized to plural entity names
4. Log detailed information about what's found

### Frontend Should:
1. Receive rules with entity names matching `ACTIVE_ENTITIES`
2. Match entity names flexibly (singular/plural)
3. Display rules for selected entities in scan config modal

## Questions to Answer

1. **What entity names are actually used in Firestore collections?**
   - Check Firebase Console for actual collection paths
   - Are they "contractors" or "Contractors/Volunteers" or something else?

2. **Do the rules have the `enabled` field set correctly?**
   - Check if rules exist but are disabled
   - Check if `enabled` field is missing (should default to True)

3. **Are rules stored in a different collection structure?**
   - Maybe under `rules/{category}/{table_name}` instead of `rules/{category}/{entity}`?

4. **Are there Firestore security rules blocking access?**
   - Check if backend service account has read permissions

## Debugging Commands

### Check backend logs
```bash
tail -f logs/backend.log | grep -i "rules\|entity\|contractor\|student"
```

### Test rules API endpoint
```bash
# Get auth token first, then:
curl -H "Authorization: Bearer <token>" http://localhost:8000/rules | jq
```

### Check what entities are in table_mapping.yaml
```bash
cat backend/config/table_mapping.yaml
```

## Related Issues

1. **Issue count double-counting** - ✅ Fixed
2. **Rules not loading for contractors/students** - 🔴 In Progress
3. **Entity name singular/plural handling** - ✅ Implemented (but not solving the issue)

## Notes

- The Rules Management page successfully loads and displays rules, so the rules definitely exist
- The backend is querying the correct paths based on `table_mapping.yaml`
- The migration script found 0 rules, confirming rules are NOT under singular names
- Backend logs show "Some expected entities have no rules" warning
- Need to verify actual Firestore collection structure and entity names used

