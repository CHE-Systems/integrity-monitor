# Rule Creation Forms Update - Complete ✅

## What Changed

Updated both the AI Rule Creator and Manual Rule Editor to properly support table/entity selection and rule type selection, making it easy to create rules for specific tables.

## Key Improvements

### 1. AI Rule Creator (`AIRuleCreator.tsx`)

**New Features:**
- ✅ **Table Selection with Auto-Detect**
  - Radio button choice: "Auto-detect from description" or "Select manually"
  - When viewing a table (e.g., Students), it pre-selects that table
  - Manual selection shows dropdown with all available tables
  - Auto-detect lets AI determine the table from your description

- ✅ **Better Visual Feedback**
  - Shows both Rule Type and Table as badges in the preview
  - Indicates when manual selection overrides AI detection
  - Clearer display of parsed rule details

**How It Works:**
```typescript
// When opened from Students tab:
<AIRuleCreator
  currentEntity="students"  // Pre-selects Students table
  ...
/>
```

**Example Usage:**
1. You're on the Students tab
2. Click "Create Rule with AI"
3. Table is pre-selected as "Students" (but you can change it)
4. Type: "Must have an emergency contact"
5. AI detects it's a required field rule
6. Preview shows: Type: required_fields, Table: students
7. Click "Use This Rule" to create it

### 2. Manual Rule Editor (`RuleEditor.tsx`)

**New Features:**
- ✅ **Rule Type Selection (Create Mode)**
  - Dropdown to choose: Duplicate Detection, Relationship, Required Field, or Attendance
  - Form fields change dynamically based on rule type selected
  - When editing, rule type is locked (can't change existing rule's type)

- ✅ **Table Selection (Create Mode)**
  - Dropdown to choose which table the rule applies to
  - Pre-selected based on current tab you're viewing
  - Hidden for attendance rules (those are global)
  - When editing, table is locked (can't move rule to different table)

- ✅ **Improved Field Placeholders**
  - Better placeholder text for all fields
  - Examples to guide rule creation
  - Required fields clearly marked with asterisks

**Signature Change:**
```typescript
// Old signature:
onSave: (ruleData: Record<string, any>) => void

// New signature:
onSave: (ruleData: Record<string, any>, category: string, entity: string | null) => void
```

**Form Layout (Create Mode):**
```
┌─────────────────────────────────────────┐
│ Create Rule                             │
├─────────────────────────────────────────┤
│ Rule Type *                             │
│ [Duplicate Detection ▼]                 │
│                                         │
│ Table *                                 │
│ [Students ▼]                            │
│                                         │
│ [Rule-specific fields...]               │
│                                         │
│ [Cancel]              [Create]          │
└─────────────────────────────────────────┘
```

### 3. RulesPage Updates

**Changes:**
- Passes `currentEntity={activeEntity}` to both forms
- Updated `handleSaveRule` to accept category and entity parameters
- Forms now know which table tab you're currently viewing

## Form Field Details

### Duplicate Detection Rules
- **Rule ID** * (auto-generated or custom)
- **Description** * (what the rule detects)
- **Severity** (Likely vs Possible)
- **Conditions** * (JSON array of matching conditions)

### Relationship Rules
- **Target Entity** * (dropdown of tables)
- **Message** * (error message)
- **Min Links** (minimum required links)
- **Max Links** (maximum allowed links)
- **Require Active** (checkbox)

### Required Field Rules
- **Field Name** * (e.g., "email", "phone")
- **Message** * (error message)
- **Severity** (Info, Warning, Critical)

### Attendance Rules
- **Thresholds** (JSON object with threshold values)

## User Experience Flow

### Creating a Rule with AI

1. **Navigate to table tab** (e.g., Students)
2. **Click "Create Rule with AI"**
3. **Choose table option:**
   - Auto-detect: AI will determine from your description
   - Manual: Select from dropdown (pre-selected to current tab)
4. **Enter description:** "Students must have an emergency contact"
5. **Optionally select rule type** (or let AI detect)
6. **Click "Parse with AI"**
7. **Review parsed rule:**
   - Type: required_fields
   - Table: students
   - Field data shown
8. **Click "Use This Rule"**
9. **Rule is created** for the specified table

### Creating a Rule Manually

1. **Navigate to table tab** (e.g., Students)
2. **Click "+ Add Duplicate Rule"** (or other rule type button)
3. **Form opens with:**
   - Rule Type: Pre-selected based on which button you clicked
   - Table: Pre-selected to current tab (Students)
4. **Fill in fields** specific to that rule type
5. **Click "Create"**
6. **Rule is created** for the specified table

### Editing an Existing Rule

1. **Click Edit icon** on any rule card
2. **Form opens with:**
   - Rule Type: Locked (shown but not editable)
   - Table: Locked (shown but not editable)
   - All current values populated
3. **Modify rule data**
4. **Click "Save"**
5. **Rule is updated** in Firestore

## Files Modified

1. **[frontend/src/components/AIRuleCreator.tsx](frontend/src/components/AIRuleCreator.tsx)**
   - Added `currentEntity` prop
   - Added table selection UI (auto-detect vs manual)
   - Added entity options dropdown
   - Enhanced preview display

2. **[frontend/src/components/RuleEditor.tsx](frontend/src/components/RuleEditor.tsx)**
   - Added `currentEntity` prop
   - Changed `onSave` signature to include category and entity
   - Added rule type selector for create mode
   - Added table selector for create mode
   - Improved field placeholders and validation

3. **[frontend/src/pages/RulesPage.tsx](frontend/src/pages/RulesPage.tsx)**
   - Updated `handleSaveRule` to accept new parameters
   - Passes `currentEntity={activeEntity}` to both forms
   - Forms now context-aware of which table you're viewing

## Benefits

✅ **Context-Aware** - Forms know which table you're viewing and pre-select it
✅ **Flexible** - Can override the pre-selected table if needed
✅ **Intuitive** - Table selection works like you'd expect
✅ **AI-Powered** - Can auto-detect table from natural language
✅ **Type-Safe** - Proper TypeScript types for all new parameters
✅ **Consistent** - Both forms follow same pattern

## Example Scenarios

### Scenario 1: Quick Rule for Current Table
1. On Students tab
2. Click "+ Add Required Field"
3. Table already selected as "Students"
4. Just fill in field name and message
5. Click Create - Done!

### Scenario 2: AI Rule with Auto-Detect
1. On Students tab
2. Click "Create Rule with AI"
3. Select "Auto-detect from description"
4. Type: "Parents must have a valid email address"
5. AI detects: Table = parents (not students!)
6. Review and use

### Scenario 3: AI Rule with Manual Override
1. On any tab
2. Click "Create Rule with AI"
3. Select "Select manually"
4. Choose "Contractors" from dropdown
5. Type: "Must have certification date"
6. AI parses rule for Contractors table
7. Create rule

### Scenario 4: Create Rule for Different Table
1. On Students tab
2. Click "Create Rule Manually"
3. Change "Rule Type" to "Relationship"
4. Change "Table" to "Classes"
5. Fill in relationship details
6. Create rule for Classes (even though you're on Students tab)

## Testing Checklist

- [x] AI Creator pre-selects current table
- [x] AI Creator auto-detect mode works
- [x] AI Creator manual selection works
- [x] AI Creator manual selection overrides AI detection
- [x] Manual Editor pre-selects current table
- [x] Manual Editor pre-selects rule type from context button
- [x] Manual Editor allows changing table in create mode
- [x] Manual Editor allows changing rule type in create mode
- [x] Manual Editor locks table in edit mode
- [x] Manual Editor locks rule type in edit mode
- [x] Form fields update when changing rule type
- [x] Validation works for all rule types
- [x] Rules save to correct table
- [x] Rules save with correct category

## Next Steps (Optional)

1. **Add Field Suggestions** - When creating required field rules, suggest available fields from the table
2. **Add Target Validation** - For relationships, validate that target table exists
3. **Add Condition Builder** - For duplicates, add a visual condition builder instead of JSON
4. **Add Rule Templates** - Common rule templates users can start from
5. **Add Rule Preview** - Show what issues the rule would detect before saving

## Summary

🎉 **Rule creation is now table-centric and intelligent!**

Both the AI Rule Creator and Manual Rule Editor now:
- Know which table you're viewing
- Pre-select that table for new rules
- Let you choose different tables if needed
- Support all rule types with proper type selection
- Provide clear, guided form filling

The forms work seamlessly with the table-centric UI redesign, making it intuitive to create and manage rules for each table.
