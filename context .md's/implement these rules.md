# Full Database Scan — Data Validation & Integrity Checks

## Baseline (your current checks)
- Duplicate records
- Missing relational links
- Anomalies within records

---

## Core relational integrity
- **Orphaned children**: child rows whose FK points to a non-existent parent.
- **Dangling parents**: parents missing required children (when business rules require at least 1).
- **Broken many-to-many links**: join-table rows where either side is missing.
- **Cardinality violations**: “should be 1:1” relations that are actually 1:many, etc.
- **Unexpected cycles**: circular references in self-referential graphs (e.g., `parent_id`, `manager_id`) where disallowed.
- **Soft-delete consistency**: children active while parent is soft-deleted (or vice versa), if not allowed.

## Uniqueness and identity
- **Natural key duplicates**: email, external_id, SIS_id, slug, etc.
- **Near-duplicates**: fuzzy matches (name + DOB, normalized phone, normalized address).
- **ID type/format mismatches**: string vs int ids, trimmed vs untrimmed, case-sensitivity issues.
- **External ID collisions**: two internal records mapped to one upstream record.

## Required fields and completeness
- **Null/blank violations**: required fields missing, whitespace-only strings.
- **Partial required groups**: if any of `{A,B,C}` present then all must be present.
- **Coverage by segment**: % missing key attributes by campus/year/status/role.

## Domain and format validation
- **Enum violations**: status/type fields not in allowed set.
- **Range violations**: negative counts, impossible dates, invalid percentages (>100), etc.
- **String format checks**: email/phone/postal/UUID/date-time parsing.
- **Normalization consistency**: casing, extra spaces, standard abbreviations (state/country).

## Cross-field business rules (within a record)
- **Conditional constraints**: e.g., `status=ACTIVE` requires `start_date` and `campus_id`.
- **Mutual exclusivity**: only one of fields `{x,y}` can be set.
- **Derived-field consistency**: stored totals match sum of components (credits, invoices, attendance).
- **Units consistency**: minutes vs hours, cents vs dollars, timezone assumptions.

## Temporal integrity
- **Impossible timelines**: `end_date < start_date`, `created_at > updated_at`, etc.
- **Overlap conflicts**: overlapping active intervals where they should be disjoint.
- **State transition validity**: illegal workflow jumps (DRAFT → ARCHIVED without SUBMITTED).
- **Stale “active” records**: active records not updated within expected window.

## Aggregate and reconciliation checks
- **Rollup drift**: denormalized counters don’t match source-of-truth counts.
- **Balance checks**: ledger debits/credits sum to zero; invoice totals reconcile to line items.
- **Partition completeness**: every record belongs to exactly one bucket (year/term/campus), none “unknown.”

## Consistency across duplicated/denormalized data
- **Copied fields drift**: cached parent fields in child no longer match the parent.
- **Materialized search fields**: search/index copies out of sync with canonical fields.
- **Foreign label mismatch**: FK points to parent but stored `parent_name`/label doesn’t match.

## Anomaly and outlier detection (beyond simple per-record anomalies)
- **Statistical outliers**: z-score/IQR for numeric fields (hours, charges, attendance counts).
- **Distribution drift**: sharp proportion changes vs prior runs (possible pipeline regression).
- **Impossible combinations**: disallowed value pairings detected via rule set.

## Operational and metadata integrity
- **Audit trail gaps**: missing `created_by`/`updated_by`, missing change history where required.
- **Duplicate “current” flags**: multiple active versions when only one should be current.
- **Attachment/file integrity**: missing blobs for referenced attachments; checksum/size mismatches (if tracked).
- **Constraint/index coverage**: identifiers without unique constraints/indexes (where applicable).

---

## Recommended run order (signal → noise)
1. Schema/type/format  
2. Required fields  
3. Uniqueness  
4. Referential integrity  
5. Cross-field rules  
6. Temporal/overlaps  
7. Rollups/reconciliation  
8. Outliers/drift
