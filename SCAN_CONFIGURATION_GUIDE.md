# Scan Configuration System - User Guide

## Overview

Your data integrity monitor now supports **custom rule selection for every scan**. Each time you run a scan, you can select exactly which rules to run, and those selections are preserved with the scan results for complete audit trail.

## Current System State (Contractors-Only)

### Available Rules

The system is currently simplified to **contractors table only** with the following rules:

#### Duplicate Detection (2 rules)

1. **dup.contractor.ein** - EIN or business ID matches
2. **dup.contractor.email_phone** - Email or phone matches plus name similarity

#### Required Fields (5 rules)

1. **required_field.contractors.email** - Email is required
2. **required_field.contractors.cell_phone** - Cell phone is required
3. **required_field.contractors.contractor_vol** - Contractor/Vol role type is required
4. **required_field.contractors.certification** - Certification is required
5. **required_field.contractors.approval_status** - Approval status is required

#### Relationships (0 rules)

- No relationship rules configured for contractors

#### Attendance (0 rules)

- No attendance threshold rules configured

**Total: 7 active rules** (2 duplicates + 5 required fields)

---

## How to Configure a Scan

### Step 1: Open Scan Configuration Modal

Click "Run Scan" to open the configuration modal. The modal has two columns:

- **Left Column**: Table/Entity Selection
- **Right Column**: Check Types & Rules Selection

### Step 2: Select Tables

1. Check the box next to **"Contractors/Volunteers"** to include that table in the scan
2. You can select "Select All" to quickly choose all available tables
3. **IMPORTANT**: You must select at least one table to run a scan

### Step 3: Select Check Types & Rules

For each check type (Duplicates, Missing Links, Missing Fields, Attendance), you can:

1. **Click the checkbox** to quickly select/deselect ALL rules in that category
2. **Click the expand arrow (▶/▼)** to see individual rules
3. **Select specific rules** by checking individual rule checkboxes

#### Example: Selecting Only Email Validation

1. Select "Contractors/Volunteers" table
2. Expand "Missing Fields" check type
3. Find "Contractors/Volunteers" subsection
4. Check only **"required_field.contractors.email"**
5. Leave all other rules unchecked

**Result**: The scan will ONLY check for missing email fields in contractors records

### Step 4: Review Selection

At the bottom of the modal, you'll see a count of selected rules:

```
5 rules will be used for this scan
```

This counter updates in real-time as you select/deselect rules.

### Step 5: Run Scan

Click "Run Scan" button (only enabled if you have at least 1 table and 1 rule selected)

---

## How Rule Selection Works

### What Happens When You Run a Scan

1. **Selection Captured**: Your exact rule selection is captured as `run_config`
2. **Persisted to Firestore**: The `run_config` is saved with the scan metadata
3. **Backend Filtering**: The integrity runner filters the schema to ONLY include selected rules
4. **Execution**: ONLY the selected rules are executed against the fetched data
5. **Results Display**: The run details page shows which rules were selected (not inferred from issues)

### Key Principle: Explicit Selection Only

**The system uses a whitelist approach**:

- If a category (duplicates, relationships, required_fields) is **not present** in your selection → **ALL rules in that category are skipped**
- If a category **is present but has an empty array** for an entity → **All rules for that entity are skipped**
- If a category has specific rule IDs → **Only those rule IDs are executed**

### Example Configurations

#### Configuration 1: Only Duplicate Detection

```json
{
  "entities": ["contractors"],
  "rules": {
    "duplicates": {
      "contractors": ["dup.contractor.ein", "dup.contractor.email_phone"]
    }
  }
}
```

**Result**: Scans contractors for duplicates only. No required field checks, no relationship checks.

#### Configuration 2: Only Email Validation

```json
{
  "entities": ["contractors"],
  "rules": {
    "required_fields": {
      "contractors": ["required_field.contractors.email"]
    }
  }
}
```

**Result**: Scans contractors for missing email only. All other required field checks skipped.

#### Configuration 3: Full Scan

```json
{
  "entities": ["contractors"],
  "rules": {
    "duplicates": {
      "contractors": ["dup.contractor.ein", "dup.contractor.email_phone"]
    },
    "required_fields": {
      "contractors": [
        "required_field.contractors.email",
        "required_field.contractors.cell_phone",
        "required_field.contractors.contractor_vol",
        "required_field.contractors.certification",
        "required_field.contractors.approval_status"
      ]
    }
  }
}
```

**Result**: Scans contractors for all duplicate rules and all required field rules.

---

## Viewing Scan Results

### Run Details Page

After a scan completes, view the run details to see:

1. **Rules Used in Scan** - Shows the ACTUAL rules you selected (not inferred from issues)
2. **Issues Found** - Grouped by rule type and severity
3. **Metrics** - Total issues, duration, record counts

### Important: Rules with 0 Issues

**The system now shows ALL selected rules, even if they found 0 issues**

Previously, if a rule was selected but found no issues, it wouldn't appear in "Rules Used". This was confusing and made it seem like different rules were running.

Now:

- If you select 7 rules, you'll see all 7 rules listed
- Rules with 0 issues will show "0 issues found"
- This gives you complete visibility into what actually ran

---

## Backend Implementation Details

### Run Config Persistence

The `run_config` is persisted at 4 key points during scan execution:

1. **Initial write** - When scan starts (status: "running")
2. **Progress update** - After data fetch completes
3. **Final write** - When scan completes successfully
4. **Error handling** - In the finally block if scan fails

This ensures the run config is always available for audit purposes.

### Rule Filtering Pipeline

```
Schema YAML → Load into SchemaConfig
      ↓
User Selection (run_config) → Filter SchemaConfig
      ↓
Filtered SchemaConfig → Execute checks
      ↓
Only Selected Rules Run → Issues Generated
```

The filtering happens in `integrity_runner.py` in the `_filter_rules_by_selection()` method (lines 1067-1300).

### Firestore Storage

Rules are stored in Firestore with this structure:

```
rules/
  duplicates/
    contractors/
      dup.contractor.ein
      dup.contractor.email_phone
  required_fields/
    contractors/
      required_field.contractors.email
      required_field.contractors.cell_phone
      required_field.contractors.contractor_vol
      required_field.contractors.certification
      required_field.contractors.approval_status
```

---

## Maintenance Scripts

### Verify Contractors-Only Setup

```bash
python -m backend.scripts.verify_contractors_only
```

Checks that:

- schema.yaml only has contractors entity
- rules.yaml only has contractors Airtable config
- Firestore only has contractors rules

### List All Firestore Rules

```bash
python -m backend.scripts.list_firestore_rules
```

Shows detailed inventory of all rules in Firestore.

### Clean Non-Contractor Rules

```bash
python -m backend.scripts.cleanup_non_contractor_rules --confirm
```

Removes all non-contractor rules from Firestore (use if other entities accidentally get added).

### Create Rules Snapshot (Backup)

```bash
python -m backend.scripts.migrate_rules --output schema.yaml.snapshot
```

Creates a read-only snapshot/backup of Firestore rules to YAML file.
**Note:** Rules are managed in Firestore only. schema.yaml has been removed.

---

## Troubleshooting

### Problem: Rules not appearing in scan config modal

**Solution**: Check that rules are in Firestore

```bash
python -m backend.scripts.list_firestore_rules
```

If rules are missing, create them using the Rules UI or API.
Rules are managed in Firestore only - there is no YAML file to sync from.

### Problem: Seeing different rules than selected

**Diagnosis**: This was the original bug that has now been fixed.

**Verification**:

1. Check the run details page - it should show rules from `run_config` not inferred from issues
2. Look at backend logs for "Selected rules from run_config" and "Rule filtering: after filtering"

### Problem: Can't run scan (Run Scan button disabled)

**Causes**:

- No tables selected → Select at least 1 table
- No rules selected → Select at least 1 rule
- Rules count shows "0 rules" → Check individual checkboxes

### Problem: Non-contractor entities appearing

**Solution**: Run cleanup script

```bash
python -m backend.scripts.cleanup_non_contractor_rules --confirm
python -m backend.scripts.verify_contractors_only
```

---

## Key Files

### Frontend

- `frontend/src/components/ScanConfigModal.tsx` - Scan configuration UI
- `frontend/src/hooks/useRules.ts` - Loads rules from backend
- `frontend/src/hooks/useRunStatus.ts` - TypeScript interface for run_config
- `frontend/src/pages/RunStatusPage.tsx` - Displays selected rules

### Backend

- `backend/services/integrity_runner.py` - Rule filtering logic (\_filter_rules_by_selection method)
- Rules are managed in Firestore only (schema.yaml has been removed)
- `backend/config/rules.yaml` - Runtime configuration
- `backend/fetchers/registry.py` - Entity fetcher registry

### Scripts

- `backend/scripts/verify_contractors_only.py` - Verification script
- `backend/scripts/list_firestore_rules.py` - Inventory script
- `backend/scripts/cleanup_non_contractor_rules.py` - Cleanup script
- `backend/scripts/migrate_rules.py` - Snapshot/backup script (read-only)

---

## Summary

✅ **Custom rule selection per scan** - Select exactly which rules to run each time
✅ **Persistent configuration** - Rule selection saved with scan results
✅ **Complete audit trail** - See what rules were ACTUALLY selected, not inferred
✅ **Zero-issue visibility** - Selected rules show even if they found 0 issues
✅ **Contractors-only** - System simplified to 7 rules for easy testing

You now have complete control over which integrity checks run on each scan!
