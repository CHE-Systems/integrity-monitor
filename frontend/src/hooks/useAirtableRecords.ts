import { useState, useEffect, useCallback } from "react";
import { auth } from "../config/firebase";
import { API_BASE } from "../config/api";
import { useAirtableSchema } from "../contexts/AirtableSchemaContext";
import type { AirtableSchema, AirtableTable } from "../utils/airtable";

export interface AirtableRecordFields {
  [key: string]: unknown;
}

export interface AirtableRecord {
  id: string;
  fields: AirtableRecordFields;
  createdTime?: string;
}

export interface AirtableRecordsResponse {
  records: Record<string, AirtableRecord>;
  count: number;
  error?: string;
}

interface UseAirtableRecordsResult {
  records: Record<string, AirtableRecord>;
  linkedRecordNames: Record<string, string>;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

/**
 * Hook to fetch Airtable records by their IDs.
 * Automatically resolves linked record display names using the schema.
 * @param entity - Entity type (students, parents, contractors, etc.)
 * @param recordIds - List of record IDs to fetch
 * @returns Object with records keyed by ID, linked record names, loading state, and error
 */
export function useAirtableRecords(
  entity: string | undefined,
  recordIds: string[]
): UseAirtableRecordsResult {
  const { schema } = useAirtableSchema();
  const [records, setRecords] = useState<Record<string, AirtableRecord>>({});
  const [linkedRecordNames, setLinkedRecordNames] = useState<
    Record<string, string>
  >({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchRecords = useCallback(async () => {
    if (!entity || recordIds.length === 0) {
      setRecords({});
      setLinkedRecordNames({});
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const user = auth.currentUser;
      if (!user) {
        throw new Error("Not authenticated");
      }

      const token = await user.getIdToken();

      const response = await fetch(`${API_BASE}/airtable/records/by-ids`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          entity,
          record_ids: recordIds,
        }),
      });

      if (!response.ok) {
        const errorData = await response
          .json()
          .catch(() => ({ error: "Failed to fetch records" }));
        throw new Error(
          errorData.detail?.message ||
            errorData.error ||
            "Failed to fetch records"
        );
      }

      const data: AirtableRecordsResponse = await response.json();

      if (data.error) {
        throw new Error(data.error);
      }

      const fetchedRecords = data.records || {};
      setRecords(fetchedRecords);

      // Phase 2: Resolve linked record names (non-blocking)
      if (schema && Object.keys(fetchedRecords).length > 0) {
        try {
          const names = await resolveLinkedRecordNames(
            entity,
            fetchedRecords,
            schema,
            token
          );
          setLinkedRecordNames(names);
        } catch (err) {
          console.warn("Failed to resolve linked record names:", err);
          // Non-critical — don't block the main display
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch records");
      setRecords({});
      setLinkedRecordNames({});
    } finally {
      setLoading(false);
    }
  }, [entity, recordIds.join(","), schema]);

  useEffect(() => {
    fetchRecords();
  }, [fetchRecords]);

  return {
    records,
    linkedRecordNames,
    loading,
    error,
    refetch: fetchRecords,
  };
}

// ---------------------------------------------------------------------------
// Linked record resolution
// ---------------------------------------------------------------------------

/**
 * Find the schema table matching an entity name.
 */
function findTableForEntity(
  entity: string,
  schema: AirtableSchema
): AirtableTable | null {
  const entityLower = entity.toLowerCase().trim();
  const entityMapping: Record<string, string> = {
    student: "students",
    parent: "parents",
    contractor: "contractors",
    class: "classes",
  };
  const normalized = entityMapping[entityLower] ?? entityLower;

  for (const table of schema.tables) {
    const tname = table.name.toLowerCase().trim();
    const tnorm = tname.replace(/\s+/g, "_");
    const entitySpaces = normalized.replace(/_/g, " ");

    if (
      tname === normalized ||
      tname === entityLower ||
      tname === entitySpaces ||
      tnorm === normalized ||
      normalized.includes(tname) ||
      tname.includes(normalized)
    ) {
      return table;
    }
  }
  return null;
}

/**
 * After fetching the main records, scan for linked record ID arrays,
 * identify their target tables via the schema, fetch those records,
 * and extract display names (primary field values).
 */
async function resolveLinkedRecordNames(
  entity: string,
  records: Record<string, AirtableRecord>,
  schema: AirtableSchema,
  token: string
): Promise<Record<string, string>> {
  const entityTable = findTableForEntity(entity, schema);
  if (!entityTable) return {};

  // Find multipleRecordLinks fields and their target tables
  const linkFields = entityTable.fields.filter(
    (f) => f.type === "multipleRecordLinks"
  );
  if (linkFields.length === 0) return {};

  // Collect all linked record IDs grouped by target table ID
  const linkedIdsByTable: Record<string, Set<string>> = {};

  for (const record of Object.values(records)) {
    for (const linkField of linkFields) {
      const value = record.fields[linkField.name];
      if (!Array.isArray(value)) continue;

      const opts = linkField.options as
        | { linkedTableId?: string }
        | undefined;
      const targetTableId = opts?.linkedTableId;
      if (!targetTableId) continue;

      if (!linkedIdsByTable[targetTableId]) {
        linkedIdsByTable[targetTableId] = new Set();
      }
      for (const id of value) {
        if (typeof id === "string" && id.startsWith("rec")) {
          linkedIdsByTable[targetTableId].add(id);
        }
      }
    }
  }

  if (Object.keys(linkedIdsByTable).length === 0) return {};

  // Build table ID → entity name map
  const tableIdToName: Record<string, string> = {};
  for (const table of schema.tables) {
    // Use the table name as the entity, normalizing spaces to underscores
    tableIdToName[table.id] = table.name.toLowerCase().replace(/\s+/g, "_");
  }

  // Fetch linked records for each target table (in parallel)
  const names: Record<string, string> = {};

  const fetchPromises = Object.entries(linkedIdsByTable).map(
    async ([tableId, ids]) => {
      const entityName = tableIdToName[tableId];
      if (!entityName || ids.size === 0) return;

      const targetTable = schema.tables.find((t) => t.id === tableId);
      if (!targetTable) return;

      // Only resolve up to 20 linked records per table
      const idsToFetch = Array.from(ids).slice(0, 20);

      try {
        const resp = await fetch(`${API_BASE}/airtable/records/by-ids`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            entity: entityName,
            record_ids: idsToFetch,
          }),
        });

        if (!resp.ok) return;

        const data: AirtableRecordsResponse = await resp.json();
        if (!data.records) return;

        for (const [rid, record] of Object.entries(data.records)) {
          const displayName = extractPrimaryDisplayName(
            record.fields,
            targetTable
          );
          if (displayName) {
            names[rid] = displayName;
          }
        }
      } catch {
        // Silently skip — linked name resolution is best-effort
      }
    }
  );

  await Promise.all(fetchPromises);
  return names;
}

/**
 * Extract the primary display name from a linked record's fields.
 * Tries the primary field first, then falls back to common name patterns.
 */
function extractPrimaryDisplayName(
  fields: AirtableRecordFields,
  table: AirtableTable
): string | null {
  // Try common name / identifier fields first
  const namePatterns = [
    /^entry\s*id$/i,
    /^full\s*name$/i,
    /^name$/i,
    /^title$/i,
  ];

  for (const pattern of namePatterns) {
    for (const [key, value] of Object.entries(fields)) {
      if (pattern.test(key) && typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
  }

  // Try combining first + last name
  let firstName = "";
  let lastName = "";
  for (const [key, value] of Object.entries(fields)) {
    if (/first\s*name/i.test(key) && typeof value === "string") {
      firstName = value.trim();
    }
    if (/last\s*name/i.test(key) && typeof value === "string") {
      lastName = value.trim();
    }
  }
  if (firstName || lastName) {
    return `${firstName} ${lastName}`.trim();
  }

  // Last resort: use the primary field ID from the table schema
  if (table.primaryFieldId) {
    const primaryField = table.fields.find(
      (f) => f.id === table.primaryFieldId
    );
    if (primaryField) {
      const value = fields[primaryField.name];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Display field extraction
// ---------------------------------------------------------------------------

/**
 * Extract display-friendly fields from an Airtable record.
 * Works dynamically for any table type by:
 * 1. First trying to match common field patterns (name, email, date, etc.)
 * 2. Then falling back to show any displayable fields
 * 3. Always ensuring at least some fields are shown if data exists
 *
 * @param fields - The record's fields
 * @param linkedRecordNames - Optional map of record ID → display name for resolving linked records
 */
export function extractDisplayFields(
  fields: AirtableRecordFields,
  linkedRecordNames?: Record<string, string>
): { label: string; value: string }[] {
  const displayFields: { label: string; value: string }[] = [];
  const usedKeys = new Set<string>();
  const fieldKeys = Object.keys(fields);
  const MAX_FIELDS = 10;

  // Priority field patterns - these are checked first in order
  // Designed to work across all entity types (students, parents, contractors, attendance, etc.)
  const priorityPatterns: Array<{
    patterns: RegExp[];
    label: string;
    excludePatterns?: RegExp[];
  }> = [
    // Primary identifier fields (name, title, entry id)
    {
      patterns: [/^entry\s*id$/i, /^full\s*name$/i, /^name$/i, /^title$/i],
      label: "Name",
      excludePatterns: [
        /first/i,
        /last/i,
        /middle/i,
        /preferred/i,
        /prefered/i,
        /\(from/i,
      ],
    },
    // Date field (primary for Attendance records)
    {
      patterns: [/^date$/i],
      label: "Date",
      excludePatterns: [
        /birth/i,
        /enroll/i,
        /created/i,
        /modified/i,
        /today/i,
      ],
    },
    // First name
    {
      patterns: [/first\s*name/i, /legal\s*first/i],
      label: "First Name",
      excludePatterns: [/\(from/i],
    },
    // Last name
    {
      patterns: [/last\s*name/i, /legal\s*last/i, /^last$/i],
      label: "Last Name",
      excludePatterns: [/\(from/i],
    },
    // Linked parent (for Students / Student Truth)
    {
      patterns: [/parent.*link/i, /^parents?\s*$/i],
      label: "Parent",
      excludePatterns: [/\(from/i, /email/i, /phone/i],
    },
    // Linked student (for Student Truth / Parents)
    {
      patterns: [/^student$/i, /^students$/i],
      label: "Student",
      excludePatterns: [/truth/i, /\(from/i],
    },
    // Email
    {
      patterns: [/^email$/i, /email\s*address/i, /e-mail/i],
      label: "Email",
      excludePatterns: [/\(from/i],
    },
    // Phone
    {
      patterns: [/phone/i, /mobile/i, /cell/i, /telephone/i],
      label: "Phone",
      excludePatterns: [/emergency/i, /\(from/i],
    },
    // Type/Category (for contractors: Contractor/Vol)
    {
      patterns: [/^type$/i, /contractor.*vol/i, /^category$/i, /^role$/i],
      label: "Type",
    },
    // Birthdate / DOB
    {
      patterns: [
        /birth\s*date/i,
        /birthdate/i,
        /date\s*of\s*birth/i,
        /dob/i,
      ],
      label: "Birthdate",
    },
    // Grade
    {
      patterns: [/^grade$/i, /grade\s*level/i, /latest\s*grade/i],
      label: "Grade",
      excludePatterns: [/\(from/i],
    },
    // Gender
    {
      patterns: [/gender/i, /^sex$/i],
      label: "Gender",
    },
    // Status
    {
      patterns: [/^status$/i, /enrollment\s*status/i],
      label: "Status",
      excludePatterns: [/\(from/i],
    },
    // Campus
    {
      patterns: [/^campus$/i],
      label: "Campus",
      excludePatterns: [/\(from/i],
    },
    // Preferred name
    {
      patterns: [/prefer.*name/i, /nick\s*name/i],
      label: "Preferred Name",
    },
    // Enrollment date
    {
      patterns: [/enrollment\s*date/i, /date\s*enrolled/i, /enrolled\s*date/i],
      label: "Enrolled",
    },
    // Address
    {
      patterns: [/^address$/i, /street\s*address/i, /mailing\s*address/i],
      label: "Address",
    },
    // City
    {
      patterns: [/^city$/i],
      label: "City",
    },
    // State
    {
      patterns: [/^state$/i],
      label: "State",
    },
    // School Year
    {
      patterns: [/school\s*year/i],
      label: "School Year",
    },
    // Class/Subject
    {
      patterns: [/^class$/i, /^subject$/i, /^course$/i],
      label: "Class",
      excludePatterns: [/\(from/i],
    },
    // Amount/Payment
    {
      patterns: [/^amount$/i, /^payment$/i, /^total$/i],
      label: "Amount",
      excludePatterns: [/\(from/i, /rollup/i],
    },
  ];

  // Find fields matching each priority pattern
  for (const { patterns, label, excludePatterns } of priorityPatterns) {
    if (displayFields.length >= MAX_FIELDS) break;

    for (const fieldKey of fieldKeys) {
      if (usedKeys.has(fieldKey)) continue;

      const matchesPattern = patterns.some((pattern) => pattern.test(fieldKey));
      const matchesExclude =
        excludePatterns?.some((pattern) => pattern.test(fieldKey)) ?? false;

      if (matchesPattern && !matchesExclude) {
        const value = fields[fieldKey];
        const displayValue = formatFieldValue(value, linkedRecordNames);
        if (displayValue && displayValue.trim() !== "") {
          displayFields.push({ label, value: displayValue });
          usedKeys.add(fieldKey);
          break; // Move to next priority pattern
        }
      }
    }
  }

  // Dynamic fallback: Add any remaining displayable fields
  // This ensures we always show something for any table type
  for (const fieldKey of fieldKeys) {
    if (displayFields.length >= MAX_FIELDS) break;
    if (usedKeys.has(fieldKey)) continue;

    // Skip fields that are typically not useful for display
    const lowerKey = fieldKey.toLowerCase();
    if (shouldSkipField(lowerKey)) {
      continue;
    }

    const value = fields[fieldKey];
    const displayValue = formatFieldValue(value, linkedRecordNames);

    // Include if we have a displayable value
    if (
      displayValue &&
      displayValue.trim() !== "" &&
      displayValue !== "[Object]"
    ) {
      // Skip bare record IDs (but allow resolved linked record names)
      if (
        typeof value === "string" &&
        value.startsWith("rec") &&
        !linkedRecordNames?.[value]
      )
        continue;
      // Skip very long text
      if (typeof value === "string" && value.length > 200) continue;

      displayFields.push({
        label: formatFieldLabel(fieldKey),
        value: displayValue,
      });
      usedKeys.add(fieldKey);
    }
  }

  return displayFields;
}

/**
 * Determine if a field should be skipped based on its key.
 * Filters out internal fields, lookups, rollups, etc.
 */
function shouldSkipField(lowerKey: string): boolean {
  // Skip internal/system fields
  if (lowerKey.includes("zapier")) return true;
  if (lowerKey.includes("rollup")) return true;
  if (lowerKey.includes("lookup")) return true;
  if (lowerKey.includes("(from ")) return true;
  if (lowerKey.includes("record") && lowerKey.includes("id")) return true;
  if (lowerKey === "today's date") return true;
  if (lowerKey === "created" || lowerKey === "modified") return true;
  if (lowerKey.includes("copy")) return true;

  return false;
}

/**
 * Format a field key into a display-friendly label.
 * e.g., "Student's Legal First Name (as stated on their birth certificate)" -> "First Name"
 */
function formatFieldLabel(key: string): string {
  // Remove parenthetical explanations
  let label = key.replace(/\s*\([^)]*\)\s*/g, " ").trim();

  // Remove common prefixes
  label = label.replace(/^(Student's|Parent's|Contractor's)\s*/i, "");

  // Truncate long labels
  if (label.length > 25) {
    // Try to find a natural break point
    const words = label.split(/\s+/);
    label = words.slice(0, 3).join(" ");
    if (label.length > 25) {
      label = label.substring(0, 22) + "...";
    }
  }

  return label;
}

/**
 * Format a field value for display.
 * When linkedRecordNames is provided, linked record IDs are resolved to names.
 */
function formatFieldValue(
  value: unknown,
  linkedRecordNames?: Record<string, string>
): string {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "string") {
    // Try to format as date if it looks like an ISO date
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
      try {
        const date = new Date(value);
        if (!isNaN(date.getTime())) {
          return date.toLocaleDateString("en-US", {
            year: "numeric",
            month: "short",
            day: "numeric",
          });
        }
      } catch {
        // Fall through to return original value
      }
    }
    return value;
  }

  if (typeof value === "number") {
    return String(value);
  }

  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return "";

    // Check if this is an array of linked record IDs
    if (typeof value[0] === "string" && value[0].startsWith("rec")) {
      // If we have resolved names, show them
      if (linkedRecordNames) {
        const resolvedNames = value
          .map((id) =>
            typeof id === "string" ? linkedRecordNames[id] : undefined
          )
          .filter(Boolean) as string[];

        if (resolvedNames.length > 0) {
          return resolvedNames.join(", ");
        }
      }
      // Fallback: show count
      return `${value.length} linked record${value.length > 1 ? "s" : ""}`;
    }

    return value.slice(0, 3).join(", ") + (value.length > 3 ? "..." : "");
  }

  if (typeof value === "object") {
    // For attachments or other objects
    return "[Object]";
  }

  return String(value);
}
