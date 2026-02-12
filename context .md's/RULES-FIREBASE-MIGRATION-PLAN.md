# Rules Firebase Migration Plan

## Goal

Create a Firebase-based rules management system where:
1. **YAML remains source of truth** - Version-controlled, can reset to defaults
2. **Firebase allows runtime editing** - Edit, create, delete rules without code changes
3. **Full CRUD operations** - Complete management interface
4. **Sync/Reset capability** - Can reload from YAML at any time

---

## Current State

### Rules Categories

| Category | YAML File | Current Storage | Check Module |
|----------|-----------|-----------------|--------------|
| **Duplicates** | schema.yaml | `duplicates` section | checks/duplicates.py |
| **Relationships** | schema.yaml | `entities[*].relationships` | checks/links.py |
| **Required Fields** | schema.yaml | `entities[*].missing_key_data` | checks/required_fields.py |
| **Attendance** | rules.yaml | `attendance_rules` | checks/attendance.py |

### Existing Infrastructure

✅ **Already exists:**
- Firestore override system (`integrity_config/current`)
- Rules Service with CRUD operations (`/backend/services/rules_service.py`)
- API endpoints for rules management (`/backend/main.py`)
- AI rule parser for natural language (`/backend/services/ai_rule_parser.py`)
- Deep merge logic (YAML + Firestore)

❌ **Missing:**
- Frontend UI for rules management
- Bulk migration from YAML → Firestore
- Sync/Reset functionality
- Rules page in UI

---

## Firestore Schema

### Collection Structure

```
rules/
├── duplicates/
│   ├── {entity}/
│   │   ├── {rule_id}
│   │   │   ├── rule_id: string
│   │   │   ├── entity: string
│   │   │   ├── description: string
│   │   │   ├── severity: "likely" | "possible"
│   │   │   ├── conditions: array
│   │   │   ├── source: "yaml" | "firestore" | "user"
│   │   │   ├── created_at: timestamp
│   │   │   ├── updated_at: timestamp
│   │   │   ├── created_by: user_id
│   │   │   ├── updated_by: user_id
│   │   │   └── enabled: boolean
│   │
├── relationships/
│   ├── {entity}/
│   │   ├── {target_entity}
│   │   │   ├── rule_id: string (e.g., "students_parents")
│   │   │   ├── source_entity: string
│   │   │   ├── target_entity: string
│   │   │   ├── min_links: number
│   │   │   ├── max_links: number
│   │   │   ├── require_active: boolean
│   │   │   ├── message: string
│   │   │   ├── source: "yaml" | "firestore" | "user"
│   │   │   ├── created_at: timestamp
│   │   │   ├── updated_at: timestamp
│   │   │   ├── created_by: user_id
│   │   │   ├── updated_by: user_id
│   │   │   └── enabled: boolean
│   │
├── required_fields/
│   ├── {entity}/
│   │   ├── {field_name}
│   │   │   ├── rule_id: string
│   │   │   ├── entity: string
│   │   │   ├── field: string
│   │   │   ├── message: string
│   │   │   ├── severity: "info" | "warning" | "critical"
│   │   │   ├── alternate_fields: array
│   │   │   ├── condition_field: string (optional)
│   │   │   ├── condition_value: any (optional)
│   │   │   ├── source: "yaml" | "firestore" | "user"
│   │   │   ├── created_at: timestamp
│   │   │   ├── updated_at: timestamp
│   │   │   ├── created_by: user_id
│   │   │   ├── updated_by: user_id
│   │   │   └── enabled: boolean
│   │
└── attendance/
    ├── thresholds/
    │   ├── {metric_name}
    │   │   ├── rule_id: string
    │   │   ├── metric: string
    │   │   ├── info: number
    │   │   ├── warning: number
    │   │   ├── critical: number
    │   │   ├── source: "yaml" | "firestore" | "user"
    │   │   ├── created_at: timestamp
    │   │   ├── updated_at: timestamp
    │   │   ├── created_by: user_id
    │   │   ├── updated_by: user_id
    │   │   └── enabled: boolean
    │
    └── config/
        └── settings
            ├── onboarding_grace_days: number
            ├── limited_schedule_threshold: number
            ├── updated_at: timestamp
            └── updated_by: user_id
```

### Document ID Strategy

- **Duplicates**: `{entity}_{severity}_{index}` (e.g., `students_likely_001`)
- **Relationships**: `{source}_{target}` (e.g., `students_parents`)
- **Required Fields**: `{entity}_{field}` (e.g., `students_truth_id`)
- **Attendance**: `{metric_name}` (e.g., `absence_rate_30d`)

---

## Implementation Plan

### Phase 1: Backend Infrastructure ✅ (Already Done)

**Files:**
- `/backend/services/rules_service.py` - CRUD operations
- `/backend/main.py` - API endpoints
- `/backend/services/ai_rule_parser.py` - AI parsing

**API Endpoints:**
- `GET /rules` - Get all rules
- `GET /rules/{category}` - Get rules by category
- `POST /rules/{category}` - Create rule
- `PUT /rules/{category}/{rule_id}` - Update rule
- `DELETE /rules/{category}/{rule_id}` - Delete rule
- `POST /rules/ai-parse` - Parse natural language

### Phase 2: Migration & Sync Scripts 🔨 (To Build)

**File:** `/backend/scripts/migrate_rules.py`

**Features:**
1. **Load from YAML** - Read all rules from schema.yaml and rules.yaml
2. **Upload to Firestore** - Batch write to rules collections
3. **Mark source** - Set `source: "yaml"` for migrated rules
4. **Idempotent** - Can run multiple times safely
5. **Dry-run mode** - Preview changes without applying

**File:** `/backend/scripts/sync_rules.py`

**Features:**
1. **Reset to YAML** - Delete all Firestore rules, reload from YAML
2. **Sync changes** - Update Firestore rules that changed in YAML
3. **Preserve user rules** - Keep rules with `source: "user"` or `source: "firestore"`
4. **Report changes** - Show what will be added/updated/deleted

**CLI Commands:**
```bash
# Initial migration
python -m backend.scripts.migrate_rules --action=migrate

# Reset everything to YAML defaults
python -m backend.scripts.migrate_rules --action=reset

# Sync YAML changes (preserve user rules)
python -m backend.scripts.migrate_rules --action=sync

# Dry run (preview only)
python -m backend.scripts.migrate_rules --action=migrate --dry-run
```

### Phase 3: Enhanced API Endpoints 🔨 (To Build)

**New Endpoints:**

```python
# Bulk operations
POST /rules/bulk/import    # Import multiple rules at once
POST /rules/bulk/export    # Export all rules as JSON
POST /rules/bulk/reset     # Reset to YAML defaults

# YAML sync
POST /rules/sync/from-yaml # Sync from YAML (preserve user rules)
POST /rules/sync/to-yaml   # Export current rules to YAML format

# Rule management
GET /rules/{category}/{entity}           # Get all rules for entity
POST /rules/{category}/{entity}/enable   # Enable multiple rules
POST /rules/{category}/{entity}/disable  # Disable multiple rules
```

### Phase 4: Frontend UI 🔨 (To Build)

**New Page:** `/frontend/src/pages/RulesPage.tsx`

**Features:**

1. **Rules List View**
   - Group by category (Duplicates, Relationships, Required Fields, Attendance)
   - Filter by entity, severity, enabled/disabled
   - Search rules by description or rule_id
   - Bulk actions (enable, disable, delete)

2. **Rule Editor**
   - Form-based editor for each rule type
   - Visual condition builder for duplicate rules
   - Validation before save
   - AI-assisted creation (natural language input)

3. **YAML Sync Controls**
   - "Reset to YAML" button (with confirmation)
   - "Sync from YAML" button (preserve user rules)
   - Show diff before applying

4. **Rule Details**
   - View full rule configuration
   - See source (YAML vs user-created)
   - Edit history (created_at, updated_at, created_by)
   - Enable/disable toggle

**Components:**

```
/frontend/src/components/rules/
├── RulesList.tsx         # Main list view
├── RuleEditor.tsx        # Generic rule editor
├── DuplicateRuleForm.tsx # Duplicate-specific form
├── RelationshipRuleForm.tsx # Relationship-specific form
├── RequiredFieldForm.tsx # Required field form
├── AttendanceThresholdForm.tsx # Attendance threshold form
├── RuleCard.tsx          # Individual rule display
├── ConditionBuilder.tsx  # Visual condition builder
├── AIRuleInput.tsx       # Natural language input
└── SyncControls.tsx      # YAML sync UI
```

### Phase 5: Update Backend to Read from Firestore 🔄 (Modify Existing)

**Current Behavior:**
- Loads YAML as base
- Merges Firestore overrides from `integrity_config/current`

**New Behavior:**
- **Option A: Direct Firestore Read**
  - Read rules directly from `rules/` collection
  - Fall back to YAML if Firestore empty
  - YAML becomes true "defaults"

- **Option B: Hybrid (Recommended)**
  - Keep current YAML + override merge
  - Migrate overrides to new `rules/` collection structure
  - Maintain backwards compatibility

**Files to Modify:**
- `/backend/config/schema_loader.py` - Load duplicates/relationships/required_fields from Firestore
- `/backend/config/config_loader.py` - Load attendance rules from Firestore
- `/backend/services/integrity_runner.py` - Use Firestore-first config loading

---

## Migration Strategy

### Step 1: Initial Setup (Safe, No Breaking Changes)

1. **Create migration script** that reads YAML and writes to Firestore
2. **Populate Firestore** with all existing rules from YAML
3. **Mark all as `source: "yaml"`** to track origin
4. **Test dual-read** - Verify Firestore rules match YAML

### Step 2: Add Frontend UI

1. **Build Rules Page** with list, edit, create, delete
2. **Connect to existing API** endpoints
3. **Add sync controls** for YAML reset/sync

### Step 3: Switch to Firestore-First

1. **Update loaders** to read from Firestore first
2. **Fall back to YAML** if Firestore empty
3. **Keep YAML for defaults** and version control

### Step 4: Enable User Editing

1. **Allow rule creation** from UI
2. **Mark as `source: "user"`** to distinguish from YAML
3. **Preserve user rules** during YAML sync

---

## Data Flow

### Current Flow (YAML-First)
```
YAML Files
    ↓
Config Loaders (schema_loader.py, config_loader.py)
    ↓
Firestore Overrides (integrity_config/current)
    ↓
Deep Merge
    ↓
Integrity Runner → Checks
```

### New Flow (Firestore-First with YAML Fallback)
```
Firestore (rules/ collection)
    ↓
    ├─ If empty → Load from YAML
    │                ↓
    │            Migrate to Firestore
    │
    ↓
Filter by enabled=true
    ↓
Group by category
    ↓
Integrity Runner → Checks

YAML Files
    ↓
Sync/Reset Script
    ↓
Update Firestore (preserve user rules)
```

---

## API Design

### Rules CRUD

#### GET /rules
**Response:**
```json
{
  "duplicates": {
    "students": [
      {
        "rule_id": "dup.student.email_dob",
        "description": "Email exact match and DOB within ±1 day",
        "severity": "likely",
        "conditions": [...],
        "source": "yaml",
        "enabled": true,
        "created_at": "2025-01-15T10:00:00Z",
        "updated_at": "2025-01-15T10:00:00Z"
      }
    ]
  },
  "relationships": { ... },
  "required_fields": { ... },
  "attendance": { ... }
}
```

#### POST /rules/duplicates
**Request:**
```json
{
  "entity": "students",
  "description": "Same first name, last name, and campus",
  "severity": "possible",
  "conditions": [
    {"type": "exact_match", "field": "legal_first_name"},
    {"type": "exact_match", "field": "legal_last_name"},
    {"type": "exact_match", "field": "campus_id"}
  ]
}
```

**Response:**
```json
{
  "rule_id": "dup.student.custom_001",
  "status": "created",
  "message": "Rule created successfully"
}
```

#### DELETE /rules/duplicates/dup.student.email_dob
**Response:**
```json
{
  "status": "deleted",
  "message": "Rule deleted successfully"
}
```

### Bulk Operations

#### POST /rules/bulk/reset
**Request:**
```json
{
  "confirm": true,
  "preserve_user_rules": true
}
```

**Response:**
```json
{
  "status": "success",
  "deleted": 45,
  "created": 38,
  "preserved": 7,
  "message": "Rules reset to YAML defaults"
}
```

---

## UI Mockup

### Rules Page Layout

```
┌─────────────────────────────────────────────────────────┐
│  Rules Management                          [Sync ▼]     │
├─────────────────────────────────────────────────────────┤
│                                                           │
│  [Duplicates] [Relationships] [Required Fields] [Attend] │
│                                                           │
│  ┌─────────────────────────────────────────────────┐    │
│  │ Search rules...                          [+ New] │    │
│  └─────────────────────────────────────────────────┘    │
│                                                           │
│  Students (12 rules)                                      │
│  ┌──────────────────────────────────────────────┐       │
│  │ dup.student.email_dob            [Edit] [×]  │       │
│  │ Email exact match and DOB within ±1 day      │       │
│  │ Likely • Source: YAML • ⚪ Enabled           │       │
│  └──────────────────────────────────────────────┘       │
│  ┌──────────────────────────────────────────────┐       │
│  │ dup.student.name_campus          [Edit] [×]  │       │
│  │ High name similarity plus same campus        │       │
│  │ Possible • Source: User • ⚪ Enabled         │       │
│  └──────────────────────────────────────────────┘       │
│                                                           │
│  Parents (8 rules)                                        │
│  ...                                                      │
│                                                           │
└─────────────────────────────────────────────────────────┘

Sync Dropdown:
┌─────────────────────────┐
│ Reset to YAML Defaults  │
│ Sync from YAML          │
│ Export to JSON          │
│ Import from JSON        │
└─────────────────────────┘
```

### Rule Editor Modal

```
┌───────────────────────────────────────────────────────┐
│  Edit Duplicate Rule                             [×]   │
├───────────────────────────────────────────────────────┤
│                                                         │
│  Rule ID: dup.student.email_dob                        │
│                                                         │
│  Entity: [Students ▼]                                  │
│                                                         │
│  Description:                                           │
│  ┌───────────────────────────────────────────────┐    │
│  │ Email exact match and DOB within ±1 day       │    │
│  └───────────────────────────────────────────────┘    │
│                                                         │
│  Severity: ⚫ Likely  ⚪ Possible                      │
│                                                         │
│  Conditions:                                            │
│  ┌───────────────────────────────────────────────┐    │
│  │ 1. Exact Match: primary_email         [×]     │    │
│  │ 2. Date Delta: date_of_birth (±1 day) [×]     │    │
│  │                                   [+ Condition]│    │
│  └───────────────────────────────────────────────┘    │
│                                                         │
│  ⚪ Enabled                                            │
│                                                         │
│  Source: YAML • Created: 2025-01-15                    │
│                                                         │
│                          [Cancel]  [Save]              │
└───────────────────────────────────────────────────────┘
```

---

## Testing Plan

### 1. Migration Testing
```bash
# Test migration (dry run)
python -m backend.scripts.migrate_rules --dry-run

# Verify counts
# Expected: All YAML rules should appear in preview

# Run actual migration
python -m backend.scripts.migrate_rules --action=migrate

# Verify Firestore
# Check rules/ collection has all expected rules
```

### 2. CRUD Testing
```bash
# Create rule via API
curl -X POST http://localhost:8000/rules/duplicates \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"entity": "students", "description": "Test rule", ...}'

# Verify rule appears in Firestore and API response

# Update rule
curl -X PUT http://localhost:8000/rules/duplicates/test_rule_id \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"description": "Updated description"}'

# Delete rule
curl -X DELETE http://localhost:8000/rules/duplicates/test_rule_id \
  -H "Authorization: Bearer $TOKEN"
```

### 3. Sync Testing
```bash
# Modify YAML file
# Add new rule to schema.yaml

# Run sync
python -m backend.scripts.migrate_rules --action=sync

# Verify:
# - New rule added to Firestore
# - User rules preserved
# - YAML rules updated
```

### 4. UI Testing
- Create rule from UI
- Edit existing rule
- Delete rule
- Reset to YAML defaults
- Sync from YAML
- Search/filter rules

### 5. Integration Testing
- Run integrity check
- Verify rules loaded from Firestore
- Verify issues generated match rule definitions
- Test with disabled rules (should not generate issues)

---

## Rollback Plan

If issues occur:

1. **Keep YAML as fallback**
   - Config loaders can fall back to YAML if Firestore fails
   - No breaking changes to existing YAML-based flow

2. **Disable Firestore reads**
   - Set env var `USE_FIRESTORE_RULES=false`
   - Fall back to YAML-only mode

3. **Clear Firestore rules**
   ```bash
   python -m backend.scripts.migrate_rules --action=clear
   ```

---

## Next Steps

1. **Review this plan** - Confirm approach and Firestore schema
2. **Build migration script** - Create `migrate_rules.py`
3. **Run initial migration** - Populate Firestore with YAML rules
4. **Build frontend UI** - Rules management page
5. **Test thoroughly** - CRUD, sync, integrity checks
6. **Deploy incrementally** - Start with read-only UI, then enable editing

---

## Questions for You

1. **Storage preference**: Should we use the new `rules/` collection structure or keep using `integrity_config/current` with enhanced organization?

2. **Migration timing**: When do you want to run the initial YAML → Firestore migration?

3. **User rules**: Should user-created rules require approval before being used in scans, or apply immediately?

4. **Rule validation**: Should we add a "test rule" feature that shows what issues would be generated before saving?

5. **Permissions**: Who should be able to edit rules? Admins only, or all authenticated users?

---

**Ready to proceed?** Let me know if you want me to:
1. Build the migration script first
2. Create the frontend UI
3. Both simultaneously
4. Or modify this plan based on your feedback
