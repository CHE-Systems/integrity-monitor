# Rules Table Alignment - Complete ✅

## What Changed

Reorganized the rules system to align with actual Airtable tables, removing "campuses" (which doesn't exist in Airtable) and adding "student_truth" (which does exist).

## Key Changes

### 1. Removed "campuses" Entity
- **Why**: Campuses is not an actual Airtable table
- **What**: The actual table that holds campus data is called "truth"
- **Action**: Migrated all campuses rules to the truth table

### 2. Added "student_truth" Entity
- **Why**: Student Truth is an actual Airtable table
- **What**: Added student_truth as a new table section in the rules UI
- **Action**: Created a duplicate detection rule for this table

### 3. Created Student Truth Duplicate Rule
- **Rule ID**: `dup.student_truth.same_year_same_student`
- **Purpose**: Detects duplicate student truth records from the same school year with the same student
- **Conditions**:
  - Same `school_year` (exact match)
  - Same `student` (exact match)
- **Severity**: Likely (high confidence)

## Migration Details

### Rules Migrated from Campuses to Truth

The migration script successfully moved **2 rules** from campuses to truth:

1. **Relationship Rule**: `campuses_students`
   - Moved from: `rules/relationships/campuses/campuses_students`
   - Moved to: `rules/relationships/truth/campuses_students`

2. **Required Field Rule**: `campuses_timezone`
   - Moved from: `rules/required_fields/campuses/campuses_timezone`
   - Moved to: `rules/required_fields/truth/campuses_timezone`

### New Rule Created

**Duplicate Detection Rule**: `dup.student_truth.same_year_same_student`
- Created at: `rules/duplicates/student_truth/dup.student_truth.same_year_same_student`
- Detects: Duplicate student truth records with same school year and same student

## Files Modified

### Frontend Files

1. **[frontend/src/pages/RulesPage.tsx](frontend/src/pages/RulesPage.tsx)**
   - Updated `ENTITY_DISPLAY_NAMES` to remove "campuses" and add "student_truth"

2. **[frontend/src/components/AIRuleCreator.tsx](frontend/src/components/AIRuleCreator.tsx)**
   - Updated `ENTITY_OPTIONS` to remove "campuses" and add "student_truth"

3. **[frontend/src/components/RuleEditor.tsx](frontend/src/components/RuleEditor.tsx)**
   - Updated `ENTITY_OPTIONS` to remove "campuses" and add "student_truth"

### Backend Files

1. **[backend/migrate_campuses_to_truth.py](backend/migrate_campuses_to_truth.py)** (NEW)
   - Created migration script to move campuses rules to truth
   - Creates new student_truth duplicate detection rule

## Current Entity List

The rules system now supports these Airtable tables:

| Entity | Display Name | Airtable Table |
|--------|-------------|----------------|
| `students` | Students | ✓ Yes |
| `parents` | Parents | ✓ Yes |
| `contractors` | Contractors | ✓ Yes |
| `classes` | Classes | ✓ Yes |
| `attendance` | Attendance | ✓ Yes |
| `truth` | Truth | ✓ Yes (contains campus data) |
| `student_truth` | Student Truth | ✓ Yes |
| `payments` | Payments | ✓ Yes |
| ~~`campuses`~~ | ~~Campuses~~ | ✗ Removed (not a real table) |

## User Experience

### Before
- Rules page showed a "Campuses" tab
- Campuses is not an actual Airtable table
- Missing "Student Truth" despite it being an actual table

### After
- "Campuses" tab removed
- "Truth" tab contains all campus-related rules (campuses is stored in the truth table in Airtable)
- "Student Truth" tab added with duplicate detection rule
- All entity tabs now map directly to actual Airtable tables

## Migration Script Usage

The migration script can be run again safely (it checks for existing rules):

```bash
cd backend
python3 migrate_campuses_to_truth.py
```

**What it does:**
1. Scans all rule categories (duplicates, relationships, required_fields) for campuses rules
2. Copies each campuses rule to the corresponding truth collection
3. Deletes the original campuses rule
4. Creates the student_truth duplicate detection rule (if it doesn't exist)

**Output:**
```
Starting migration of campuses rules to truth table...
------------------------------------------------------------

Checking rules/duplicates/campuses...
  No campuses rules found in duplicates

Checking rules/relationships/campuses...
  Found 1 campuses rule(s)
  ✓ Migrated campuses_students to truth
  ✓ Deleted campuses_students from campuses

Checking rules/required_fields/campuses...
  Found 1 campuses rule(s)
  ✓ Migrated campuses_timezone to truth
  ✓ Deleted campuses_timezone from campuses

------------------------------------------------------------
Migration complete! Migrated 2 rule(s)
------------------------------------------------------------

Creating student_truth duplicate detection rule...
------------------------------------------------------------
  ✓ Created duplicate rule: dup.student_truth.same_year_same_student
     Description: Detects duplicate student truth records from the same school year with the same student
     Conditions: Same school_year AND same student
------------------------------------------------------------

✓ All tasks completed successfully!
```

## Testing Checklist

- [x] Campuses rules migrated to truth in Firestore
- [x] Campuses entity removed from frontend entity lists
- [x] Student_truth entity added to frontend entity lists
- [x] Student_truth duplicate rule created in Firestore
- [x] Rules page shows correct entity tabs
- [x] Can create new rules for student_truth
- [x] Can create new rules for truth (formerly campuses)

## Database Structure

### Before Migration
```
rules/
  ├── duplicates/
  ├── relationships/
  │   └── campuses/
  │       └── campuses_students
  └── required_fields/
      └── campuses/
          └── campuses_timezone
```

### After Migration
```
rules/
  ├── duplicates/
  │   └── student_truth/
  │       └── dup.student_truth.same_year_same_student
  ├── relationships/
  │   └── truth/
  │       └── campuses_students
  └── required_fields/
      └── truth/
          └── campuses_timezone
```

## Summary

✅ **Rules system now perfectly aligned with actual Airtable tables!**

All entity tabs in the rules UI now correspond to real Airtable tables:
- Removed phantom "campuses" entity (not a real table)
- Moved campuses rules to "truth" (the actual table)
- Added "student_truth" entity with duplicate detection
- Users can now manage rules for all actual Airtable tables

The rules are now organized exactly how the data is organized in Airtable, making the system more intuitive and aligned with the actual database structure.
