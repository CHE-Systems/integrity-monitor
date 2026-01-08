# Rules Snapshot Script

## Overview

The `migrate_rules.py` script creates a snapshot/backup of Firestore rules to a YAML file. This is a **read-only operation** - it does not modify Firestore. Rules are managed in Firestore only, and this script is used for backup/archival purposes.

## Important Note

**Rules are now managed in Firestore only.** The `schema.yaml` file has been removed. This script creates snapshots for backup purposes only - it does not sync rules back to Firestore.

## Features

- **Snapshot**: Export all Firestore rules to YAML file
- **Read-only**: Does not modify Firestore
- **Backup**: Create timestamped backups of your rules
- **Format**: Outputs YAML matching the old schema.yaml structure

## Usage

### Basic Snapshot

Create a snapshot with default filename:

```bash
python -m backend.scripts.migrate_rules --output schema.yaml.snapshot
```

### Timestamped Backup

Create a timestamped backup:

```bash
python -m backend.scripts.migrate_rules --output rules-backup-$(date +%Y-%m-%d).yaml
```

### Custom Output Path

Specify a custom output location:

```bash
python -m backend.scripts.migrate_rules --output backups/rules-snapshot.yaml
```

## Output Format

The snapshot YAML file matches the old `schema.yaml` structure:

```yaml
metadata:
  source: firestore_snapshot
  generated: "2024-01-01T12:00:00"
  note: "This is a snapshot/backup of Firestore rules. Rules are managed in Firestore only."

entities:
  students:
    description: "Students entity"
    relationships:
      parents:
        target: parents
        min_links: 1
        require_active: true
        message: "Students need at least one active parent/guardian."
    missing_key_data:
      - field: fldVGRpEqAyKv0o0g
        rule_id: "required_field.students.first_name"
        message: "First name is required."
        severity: warning

duplicates:
  students:
    likely:
      - rule_id: "dup.students.dob_name"
        description: "Exact DOB match plus 80%+ name similarity."
        conditions:
          - type: exact_match
            field: fldya31Cb8IADmmkp
          - type: similarity
            field: fldJtWBqZzfyiEFJl
            similarity: 0.80
```

## Rule Categories

The snapshot includes all rule categories:

### 1. Duplicate Rules
- **Firestore Path:** `rules/duplicates/{entity}/{rule_id}`
- **Output:** `duplicates.{entity}.{likely|possible}`

### 2. Relationship Rules
- **Firestore Path:** `rules/relationships/{source_entity}/{relationship_key}`
- **Output:** `entities.{entity}.relationships.{relationship_key}`

### 3. Required Field Rules
- **Firestore Path:** `rules/required_fields/{entity}/{rule_id}`
- **Output:** `entities.{entity}.missing_key_data[]`

### 4. Value Check Rules
- **Firestore Path:** `rules/value_checks/{entity}/{rule_id}`
- **Output:** `entities.{entity}.value_checks[]`

### 5. Attendance Rules
- **Firestore Path:** `rules/attendance/thresholds/{metric_name}`
- **Output:** (Not included in snapshot - managed separately)

## Examples

### Example 1: Create Snapshot

```bash
$ python -m backend.scripts.migrate_rules --output schema.yaml.snapshot

======================================================================
RULES SNAPSHOT: Firestore → YAML
======================================================================

Output file: schema.yaml.snapshot

Loading rules from Firestore...
Converting to YAML format...
Writing snapshot to schema.yaml.snapshot...

----------------------------------------------------------------------
SNAPSHOT SUMMARY
----------------------------------------------------------------------
  Duplicates:        12
  Relationships:     8
  Required Fields:   15
  Value Checks:      3
  Total Rules:       38

✅ Snapshot created successfully: schema.yaml.snapshot
```

### Example 2: Timestamped Backup

```bash
$ python -m backend.scripts.migrate_rules --output rules-backup-2024-01-15.yaml

======================================================================
RULES SNAPSHOT: Firestore → YAML
======================================================================

Output file: rules-backup-2024-01-15.yaml

Loading rules from Firestore...
Converting to YAML format...
Writing snapshot to rules-backup-2024-01-15.yaml...

✅ Snapshot created successfully: rules-backup-2024-01-15.yaml
```

## Troubleshooting

### Error: "GOOGLE_APPLICATION_CREDENTIALS not set"

Set up Firebase credentials:

```bash
# Option 1: Application Default Credentials (recommended for local dev)
gcloud auth application-default login

# Option 2: Service account key
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account.json"
```

### Error: "Failed to load rules from Firestore"

1. Verify Firestore credentials are set up correctly
2. Check that you have read permissions for the `rules/` collection
3. Verify the Firestore project is correct

### Error: "File already exists"

The script will prompt you to confirm overwrite. To avoid the prompt, use a different filename:

```bash
python -m backend.scripts.migrate_rules --output schema-$(date +%s).yaml.snapshot
```

## Best Practices

### 1. Regular Backups

Create regular snapshots for backup purposes:

```bash
# Weekly backup
python -m backend.scripts.migrate_rules --output backups/rules-$(date +%Y-W%V).yaml
```

### 2. Before Major Changes

Create a snapshot before making major rule changes:

```bash
python -m backend.scripts.migrate_rules --output backups/before-changes-$(date +%Y%m%d).yaml
```

### 3. Version Control

Commit snapshots to git for version history:

```bash
python -m backend.scripts.migrate_rules --output schema.yaml.snapshot
git add schema.yaml.snapshot
git commit -m "Snapshot of Firestore rules"
```

## Important Notes

- **Read-only**: This script does NOT modify Firestore
- **Not for syncing**: Rules are managed in Firestore only. This script is for backup only
- **Format compatibility**: The output format matches the old `schema.yaml` structure for compatibility
- **No reverse sync**: There is no way to sync from YAML back to Firestore. Use the Rules UI or API to manage rules.

## Script Architecture

```
migrate_rules.py
├── RulesSnapshot (main class)
│   └── snapshot()           # Export Firestore rules to YAML
│
├── Conversion methods:
│   └── _convert_to_yaml_format()  # Convert Firestore format to YAML
│
└── Utilities:
    └── _print_summary()     # Show statistics
```

## Support

For issues or questions:

1. Check Firestore Console for rule documents
2. Verify Firestore credentials are set up correctly
3. Review script output for errors
4. Ensure you have read permissions for the `rules/` collection
