import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { useAirtableRecords } from "../hooks/useAirtableRecords";
import { useAirtableSchema } from "../contexts/AirtableSchemaContext";
import { useRemediateActions } from "../hooks/useRemediateActions";
import { useLinkedRecordSearch } from "../hooks/useLinkedRecordSearch";
import { getAirtableLinksWithFallback } from "../utils/airtable";
import { normalizeEntityName } from "../config/entities";
import type { RecordIssue } from "../hooks/useRunRecordIds";
import ConfirmModal from "./ConfirmModal";
import airtableLogo from "../assets/Airtable-Mark-Color.svg";

interface RecordEditorProps {
  entity: string;
  recordId: string;
  issues: RecordIssue[];
  onBack: () => void;
  onSaveComplete: () => void;
}

/**
 * Extract the Airtable field name from a rule_id.
 * Formats: "required.{entity}.{fieldName}" or "required_field.{entity}.{fieldName}"
 * The fieldName is the exact Airtable column name.
 */
function getFieldNameFromRuleId(ruleId: string): string | null {
  const parts = ruleId.split(".");
  if (
    (parts[0] === "required" || parts[0] === "required_field") &&
    parts.length >= 3
  ) {
    return parts.slice(2).join(".");
  }
  return null;
}

/** Get the set of exact field names relevant to the current issues. */
function getRelevantFieldNames(issues: RecordIssue[]): Set<string> {
  const names = new Set<string>();
  for (const issue of issues) {
    const fieldName = getFieldNameFromRuleId(issue.rule_id);
    if (fieldName) names.add(fieldName);
  }
  return names;
}

interface SchemaFieldInfo {
  type: string;
  options?: any;
  /** The real Airtable field name from the schema */
  realName: string;
}

/** Normalize a string for fuzzy field matching: lowercase, replace _ with space, trim. */
function normalizeFieldName(name: string): string {
  return name.toLowerCase().replace(/_/g, " ").trim();
}

/**
 * Find a schema field by name or field ID, with fuzzy matching.
 * Handles: exact name, exact field ID, or normalized name (e.g. "parents_link" → "Parents link").
 */
function getSchemaField(
  fieldNameOrId: string,
  entity: string,
  schema: any
): SchemaFieldInfo | null {
  if (!schema?.tables) return null;
  const normalized = normalizeEntityName(entity);
  const normalizedSearch = normalizeFieldName(fieldNameOrId);
  const isFieldId = fieldNameOrId.startsWith("fld");

  for (const table of schema.tables) {
    const tableName = table.name?.toLowerCase().replace(/ /g, "_");
    if (
      tableName === normalized ||
      normalized.includes(tableName) ||
      tableName?.includes(normalized)
    ) {
      for (const field of table.fields || []) {
        // Exact name match
        if (field.name === fieldNameOrId) {
          return { type: field.type, options: field.options, realName: field.name };
        }
        // Field ID match
        if (isFieldId && field.id === fieldNameOrId) {
          return { type: field.type, options: field.options, realName: field.name };
        }
        // Normalized name match (e.g. "parents_link" → "parents link" === "Parents link".lower())
        if (normalizeFieldName(field.name) === normalizedSearch) {
          return { type: field.type, options: field.options, realName: field.name };
        }
      }
    }
  }
  return null;
}

/** Resolve a linkedTableId to an entity name using the schema. */
function resolveLinkedTableEntity(linkedTableId: string, schema: any): string | null {
  if (!schema?.tables || !linkedTableId) return null;
  for (const table of schema.tables) {
    if (table.id === linkedTableId) {
      return normalizeEntityName(table.name);
    }
  }
  return null;
}

// ----- LinkedRecordPicker -----

function LinkedRecordPicker({
  linkedEntity,
  selectedIds,
  onSelect,
}: {
  linkedEntity: string;
  selectedIds: string[];
  onSelect: (ids: string[]) => void;
}) {
  const { searchTerm, setSearchTerm, results, loading } =
    useLinkedRecordSearch(linkedEntity);
  const [showDropdown, setShowDropdown] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleSelect = (id: string) => {
    if (!selectedIds.includes(id)) {
      onSelect([...selectedIds, id]);
    }
    setSearchTerm("");
    setShowDropdown(false);
  };

  const handleRemove = (id: string) => {
    onSelect(selectedIds.filter((sid) => sid !== id));
  };

  return (
    <div ref={wrapperRef}>
      {/* Selected records */}
      {selectedIds.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {selectedIds.map((id) => {
            const match = results.find((r) => r.id === id);
            return (
              <span
                key={id}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-50 border border-blue-200 text-xs text-blue-700"
              >
                {match?.name || id}
                <button
                  type="button"
                  onClick={() => handleRemove(id)}
                  className="text-blue-400 hover:text-red-500 ml-0.5"
                >
                  &times;
                </button>
              </span>
            );
          })}
        </div>
      )}

      {/* Search input */}
      <div className="relative">
        <input
          type="text"
          value={searchTerm}
          onChange={(e) => {
            setSearchTerm(e.target.value);
            setShowDropdown(true);
          }}
          onFocus={() => {
            if (results.length > 0) setShowDropdown(true);
          }}
          placeholder={`Search ${linkedEntity}...`}
          className="w-full rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--cta-blue)]"
        />
        {loading && (
          <div className="absolute right-2 top-1.5 text-gray-400 text-xs">
            Searching...
          </div>
        )}

        {showDropdown && results.length > 0 && (
          <div className="absolute z-50 w-full bottom-full mb-1 bg-white border border-[var(--border)] rounded-lg shadow-lg max-h-48 overflow-y-auto">
            {results.map((rec) => (
              <button
                key={rec.id}
                type="button"
                onClick={() => handleSelect(rec.id)}
                disabled={selectedIds.includes(rec.id)}
                className={`w-full text-left px-3 py-2 hover:bg-gray-100 border-b border-[var(--border)] last:border-b-0 ${
                  selectedIds.includes(rec.id) ? "opacity-40" : ""
                }`}
              >
                <div className="text-sm font-medium">{rec.name}</div>
                <div className="text-xs text-gray-500 font-mono">{rec.id}</div>
              </button>
            ))}
          </div>
        )}

        {showDropdown && searchTerm.length >= 2 && !loading && results.length === 0 && (
          <div className="absolute z-50 w-full bottom-full mb-1 bg-white border border-[var(--border)] rounded-lg shadow-lg px-3 py-2 text-sm text-[var(--text-muted)]">
            No records found
          </div>
        )}
      </div>
    </div>
  );
}

// ----- RecordEditor -----

export function RecordEditor({
  entity,
  recordId,
  issues,
  onBack,
  onSaveComplete,
}: RecordEditorProps) {
  const {
    records,
    loading: recordLoading,
    error: recordError,
  } = useAirtableRecords(entity, [recordId]);
  const { schema } = useAirtableSchema();
  const {
    updateRecord,
    deleteRecord,
    loading: actionLoading,
    error: actionError,
    clearError,
  } = useRemediateActions();

  const [editedFields, setEditedFields] = useState<Record<string, unknown>>({});
  const [confirmAction, setConfirmAction] = useState<
    "save" | "delete" | null
  >(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [showOtherFields, setShowOtherFields] = useState(false);

  const record = records[recordId];

  const airtableLink = useMemo(() => {
    return getAirtableLinksWithFallback(entity, recordId, schema);
  }, [entity, recordId, schema]);

  const relevantFieldNames = useMemo(() => getRelevantFieldNames(issues), [issues]);

  // Resolve the primary field value (e.g. student name) for display
  const primaryFieldDisplay = useMemo(() => {
    if (!schema?.tables || !record) return null;
    const normalized = normalizeEntityName(entity);
    for (const table of schema.tables) {
      const tableName = table.name?.toLowerCase().replace(/ /g, "_");
      if (
        tableName === normalized ||
        normalized.includes(tableName) ||
        tableName?.includes(normalized)
      ) {
        const primaryId = table.primaryFieldId;
        if (primaryId) {
          const field = table.fields?.find((f: any) => f.id === primaryId);
          if (field) {
            const val = record.fields[field.name];
            if (val && typeof val === "string") return val;
            if (Array.isArray(val) && val.length > 0) return String(val[0]);
            if (val != null) return String(val);
          }
        }
        break;
      }
    }
    return null;
  }, [schema, entity, record]);

  // Split fields into relevant (missing/issue) fields and other fields
  const { relevantFields, otherFields } = useMemo(() => {
    const relevant: { key: string; value: unknown; schemaField: SchemaFieldInfo | null }[] = [];
    const other: { key: string; value: unknown }[] = [];

    if (!record) return { relevantFields: relevant, otherFields: other };

    // Track real Airtable field names used by relevant fields so we can exclude them from "other"
    const usedFieldNames = new Set<string>();

    // First, add relevant fields — they may or may not exist in record.fields
    // (missing fields won't be returned by Airtable)
    for (const fieldNameOrId of relevantFieldNames) {
      const schemaField = getSchemaField(fieldNameOrId, entity, schema);
      // Use the real Airtable field name from schema (e.g. "Parents link" not "parents_link")
      const realKey = schemaField?.realName ?? fieldNameOrId;
      const value = record.fields[realKey];
      usedFieldNames.add(realKey);
      relevant.push({ key: realKey, value: value ?? null, schemaField });
    }

    // Then collect all other fields from the record
    for (const [key, value] of Object.entries(record.fields)) {
      if (usedFieldNames.has(key)) continue;
      const lower = key.toLowerCase();
      if (
        lower.includes("zapier") ||
        lower.includes("rollup") ||
        lower.includes("copy") ||
        lower === "created" ||
        lower === "modified" ||
        lower.includes("today's date")
      )
        continue;
      other.push({ key, value });
    }

    other.sort((a, b) => a.key.localeCompare(b.key));

    return { relevantFields: relevant, otherFields: other };
  }, [record, relevantFieldNames, entity, schema]);

  const hasEdits = Object.keys(editedFields).length > 0;

  const handleFieldChange = useCallback(
    (key: string, value: unknown) => {
      setEditedFields((prev) => ({ ...prev, [key]: value }));
    },
    []
  );

  const handleSave = async () => {
    setConfirmAction(null);
    clearError();
    try {
      await updateRecord(entity, recordId, editedFields);
      setSuccessMessage("Record updated successfully.");
      setEditedFields({});
      setTimeout(() => {
        setSuccessMessage(null);
        onSaveComplete();
      }, 1500);
    } catch {
      // error set in hook
    }
  };

  const handleDelete = async () => {
    setConfirmAction(null);
    clearError();
    try {
      await deleteRecord(entity, recordId);
      setSuccessMessage("Record deleted successfully.");
      setTimeout(() => onSaveComplete(), 1500);
    } catch {
      // error set in hook
    }
  };

  const renderEditControl = (
    key: string,
    value: unknown,
    schemaField: SchemaFieldInfo | null
  ) => {
    const currentValue =
      editedFields[key] !== undefined ? editedFields[key] : value;
    const fieldType = schemaField?.type || null;

    // multipleRecordLinks → linked record search picker
    if (fieldType === "multipleRecordLinks" && schemaField?.options?.linkedTableId) {
      const linkedEntity = resolveLinkedTableEntity(
        schemaField.options.linkedTableId,
        schema
      );
      if (linkedEntity) {
        const selectedIds = Array.isArray(currentValue)
          ? (currentValue as string[])
          : [];
        return (
          <LinkedRecordPicker
            linkedEntity={linkedEntity}
            selectedIds={selectedIds}
            onSelect={(ids) => handleFieldChange(key, ids)}
          />
        );
      }
      // Fallback if we can't resolve the linked table
      return (
        <div>
          <span className="text-sm text-[var(--text-muted)]">
            {formatDisplayValue(value)}
          </span>
          <span className="text-xs text-gray-400 ml-2">(linked table not found in schema)</span>
        </div>
      );
    }

    // singleSelect → dropdown with options from schema
    if (fieldType === "singleSelect" && schemaField?.options?.choices) {
      const choices = schemaField.options.choices as {
        id: string;
        name: string;
        color?: string;
      }[];
      return (
        <select
          value={typeof currentValue === "string" ? currentValue : ""}
          onChange={(e) => handleFieldChange(key, e.target.value || null)}
          className="w-full rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--cta-blue)]"
        >
          <option value="">— Select —</option>
          {choices.map((ch) => (
            <option key={ch.id} value={ch.name}>
              {ch.name}
            </option>
          ))}
        </select>
      );
    }

    // multipleSelects → multi-select checkboxes
    if (fieldType === "multipleSelects" && schemaField?.options?.choices) {
      const choices = schemaField.options.choices as {
        id: string;
        name: string;
      }[];
      const selected = Array.isArray(currentValue)
        ? (currentValue as string[])
        : [];
      return (
        <div className="space-y-1">
          {choices.map((ch) => (
            <label key={ch.id} className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={selected.includes(ch.name)}
                onChange={(e) => {
                  const next = e.target.checked
                    ? [...selected, ch.name]
                    : selected.filter((s) => s !== ch.name);
                  handleFieldChange(key, next);
                }}
                className="accent-[var(--brand)] w-3.5 h-3.5"
              />
              <span className="text-sm">{ch.name}</span>
            </label>
          ))}
        </div>
      );
    }

    if (fieldType === "checkbox" || typeof value === "boolean") {
      return (
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={!!currentValue}
            onChange={(e) => handleFieldChange(key, e.target.checked)}
            className="accent-[var(--brand)] w-4 h-4"
          />
          <span className="text-sm text-[var(--text-main)]">
            {currentValue ? "Yes" : "No"}
          </span>
        </label>
      );
    }

    if (fieldType === "date" || fieldType === "dateTime") {
      return (
        <input
          type="date"
          value={typeof currentValue === "string" ? currentValue.slice(0, 10) : ""}
          onChange={(e) => handleFieldChange(key, e.target.value)}
          className="w-full rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--cta-blue)]"
        />
      );
    }

    if (
      fieldType === "number" ||
      fieldType === "currency" ||
      fieldType === "percent"
    ) {
      return (
        <input
          type="number"
          value={currentValue != null ? String(currentValue) : ""}
          onChange={(e) =>
            handleFieldChange(
              key,
              e.target.value === "" ? null : Number(e.target.value)
            )
          }
          className="w-full rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--cta-blue)]"
        />
      );
    }

    if (fieldType === "multilineText") {
      return (
        <textarea
          value={typeof currentValue === "string" ? currentValue : ""}
          onChange={(e) => handleFieldChange(key, e.target.value)}
          rows={3}
          className="w-full rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--cta-blue)]"
        />
      );
    }

    if (fieldType === "email") {
      return (
        <input
          type="email"
          value={typeof currentValue === "string" ? currentValue : ""}
          onChange={(e) => handleFieldChange(key, e.target.value || null)}
          className="w-full rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--cta-blue)]"
          placeholder="email@example.com"
        />
      );
    }

    if (fieldType === "phoneNumber") {
      return (
        <input
          type="tel"
          value={typeof currentValue === "string" ? currentValue : ""}
          onChange={(e) => handleFieldChange(key, e.target.value || null)}
          className="w-full rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--cta-blue)]"
          placeholder="(555) 555-5555"
        />
      );
    }

    // Default: text input
    return (
      <input
        type="text"
        value={currentValue != null ? String(currentValue) : ""}
        onChange={(e) => handleFieldChange(key, e.target.value || null)}
        className="w-full rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--cta-blue)]"
        placeholder="Enter value..."
      />
    );
  };

  if (recordLoading) {
    return (
      <div className="space-y-4">
        <button
          onClick={onBack}
          className="text-sm text-[var(--cta-blue)] hover:underline flex items-center gap-1"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Back
        </button>
        <div className="rounded-2xl border border-[var(--border)] bg-white p-8 text-center">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--brand)] mb-4" />
          <p className="text-[var(--text-muted)]">Loading record...</p>
        </div>
      </div>
    );
  }

  if (recordError || !record) {
    return (
      <div className="space-y-4">
        <button
          onClick={onBack}
          className="text-sm text-[var(--cta-blue)] hover:underline flex items-center gap-1"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Back
        </button>
        <div className="rounded-2xl border border-red-200 bg-red-50 p-6">
          <p className="text-sm text-red-800">
            {recordError || "Record not found. It may have been deleted."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <button
        onClick={onBack}
        className="text-sm text-[var(--cta-blue)] hover:underline flex items-center gap-1"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
        Back to queue
      </button>

      {/* Success/Error banners */}
      {successMessage && (
        <div className="rounded-xl border border-green-200 bg-green-50 p-4 text-sm text-green-800 font-medium">
          {successMessage}
        </div>
      )}
      {actionError && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {actionError}
        </div>
      )}

      {/* Issues summary */}
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
        <p className="text-xs font-medium text-amber-800 mb-2">Issues to address:</p>
        <ul className="space-y-1">
          {issues.map((issue, idx) => (
            <li key={idx} className="text-sm text-amber-700 flex items-start gap-2">
              <span
                className={`mt-0.5 inline-block w-2 h-2 rounded-full shrink-0 ${
                  issue.severity === "critical"
                    ? "bg-red-500"
                    : issue.severity === "warning"
                    ? "bg-yellow-500"
                    : "bg-blue-500"
                }`}
              />
              {issue.description || issue.rule_id}
            </li>
          ))}
        </ul>
      </div>

      {/* Record identity */}
      {primaryFieldDisplay && (
        <div className="rounded-2xl border border-[var(--border)] bg-white p-4 flex items-center gap-3">
          <div className="rounded-lg bg-[var(--bg-mid)] p-2">
            <svg className="w-5 h-5 text-[var(--text-muted)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-lg font-semibold text-[var(--text-main)] truncate" style={{ fontFamily: "Outfit" }}>
              {primaryFieldDisplay}
            </p>
            <p className="text-xs text-[var(--text-muted)] font-mono">{recordId}</p>
          </div>
          <a
            href={airtableLink.primary}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-[#2D7FF9]/10 border border-[#2D7FF9]/25 text-xs font-semibold text-[#2D7FF9] hover:bg-[#2D7FF9]/20 transition-colors"
          >
            <img src={airtableLogo} alt="Airtable" className="w-4 h-4" />
            Open in Airtable
          </a>
        </div>
      )}

      {/* Relevant (missing) fields — editable */}
      <div className="rounded-2xl border border-[var(--border)] bg-white">
        <div className="p-4 border-b border-[var(--border)] bg-gray-50/50 rounded-t-2xl">
          <h3 className="text-sm font-semibold text-[var(--text-main)]" style={{ fontFamily: "Outfit" }}>
            Missing Fields
          </h3>
          <p className="text-xs text-[var(--text-muted)] mt-1">
            Fill in the missing values below to resolve the issue.
          </p>
        </div>

        <div className="divide-y divide-[var(--border)]">
          {relevantFields.length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-[var(--text-muted)]">
              No specific fields identified for this issue. Check the issue details above.
            </div>
          )}
          {relevantFields.map(({ key, value, schemaField }) => (
            <div
              key={key}
              className="px-4 py-3 bg-[var(--brand)]/5 border-l-2 border-l-[var(--brand)]"
            >
              <div className="mb-1.5 flex items-center gap-2">
                <span className="text-xs font-medium text-[var(--text-main)]">
                  {key}
                </span>
                {schemaField && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500">
                    {schemaField.type}
                  </span>
                )}
                {(value === null || value === undefined || value === "" ||
                  (Array.isArray(value) && value.length === 0)) && (
                  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-red-100 text-red-600">
                    missing
                  </span>
                )}
              </div>
              <div>
                {renderEditControl(key, value, schemaField)}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Other fields — collapsed */}
      {otherFields.length > 0 && (
        <div className="rounded-2xl border border-[var(--border)] bg-white overflow-hidden">
          <button
            type="button"
            onClick={() => setShowOtherFields((prev) => !prev)}
            className="w-full p-4 flex items-center justify-between hover:bg-gray-50/50 transition-colors"
          >
            <span className="text-sm text-[var(--text-muted)]">
              {otherFields.length} other field{otherFields.length !== 1 ? "s" : ""}
            </span>
            <svg
              className={`w-4 h-4 text-[var(--text-muted)] transition-transform ${showOtherFields ? "rotate-180" : ""}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {showOtherFields && (
            <div className="divide-y divide-[var(--border)] border-t border-[var(--border)]">
              {otherFields.map(({ key, value }) => (
                <div key={key} className="px-4 py-2">
                  <div className="flex items-start gap-4">
                    <div className="min-w-[200px] shrink-0">
                      <span className="text-xs font-medium text-[var(--text-muted)]">
                        {key}
                      </span>
                    </div>
                    <div className="flex-1">
                      <span className="text-sm text-[var(--text-muted)]">
                        {formatDisplayValue(value)}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-between">
        <button
          onClick={() => setConfirmAction("delete")}
          disabled={actionLoading}
          className="rounded-lg border border-red-300 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 transition-colors"
        >
          Delete Record
        </button>
        <button
          onClick={() => setConfirmAction("save")}
          disabled={actionLoading || !hasEdits}
          className="rounded-lg bg-[var(--brand)] px-5 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50 transition-colors"
        >
          {actionLoading ? "Saving..." : "Save Changes"}
        </button>
      </div>

      {/* Record ID */}
      <div className="text-xs text-[var(--text-muted)]">
        Record: <code className="font-mono">{recordId}</code>
      </div>

      {/* Confirm Modals */}
      <ConfirmModal
        isOpen={confirmAction === "save"}
        title="Confirm Update"
        message={`This will update ${Object.keys(editedFields).length} field(s) on this Airtable record. This action cannot be undone.`}
        confirmLabel="Save Changes"
        onConfirm={handleSave}
        onCancel={() => setConfirmAction(null)}
      />
      <ConfirmModal
        isOpen={confirmAction === "delete"}
        title="Delete Record"
        message="This will permanently delete this record from Airtable. This action cannot be undone."
        confirmLabel="Delete"
        isDestructive={true}
        onConfirm={handleDelete}
        onCancel={() => setConfirmAction(null)}
      />
    </div>
  );
}

function formatDisplayValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "(empty)";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "(empty)";
    if (typeof value[0] === "string" && value[0].startsWith("rec")) {
      return `${value.length} linked record${value.length > 1 ? "s" : ""}`;
    }
    return value.slice(0, 5).join(", ") + (value.length > 5 ? "..." : "");
  }
  if (typeof value === "string") {
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
      try {
        return new Date(value).toLocaleDateString("en-US", {
          year: "numeric",
          month: "short",
          day: "numeric",
        });
      } catch {
        /* fall through */
      }
    }
    return value.length > 150 ? value.slice(0, 147) + "..." : value;
  }
  return String(value);
}
