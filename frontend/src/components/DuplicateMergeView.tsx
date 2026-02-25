import { useState, useMemo, useCallback, Fragment } from "react";
import { useAirtableRecords } from "../hooks/useAirtableRecords";
import { useAirtableSchema } from "../contexts/AirtableSchemaContext";
import { useRemediateActions } from "../hooks/useRemediateActions";
import { normalizeEntityName } from "../config/entities";
import { getAirtableLinksWithFallback } from "../utils/airtable";
import ConfirmModal from "./ConfirmModal";
import airtableLogo from "../assets/Airtable-Mark-Color.svg";

interface DuplicateMergeViewProps {
  entity: string;
  primaryRecordId: string;
  secondaryRecordIds: string[];
  onBack: () => void;
  onMergeComplete: () => void;
}

type FieldSelection = Record<string, "primary" | "secondary" | "both">;

function formatValue(value: unknown, linkedRecordNames?: Record<string, string>): string {
  if (value === null || value === undefined || value === "") return "(empty)";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "(empty)";
    if (typeof value[0] === "string" && value[0].startsWith("rec")) {
      if (linkedRecordNames) {
        const resolved = value
          .map((id) => (typeof id === "string" ? linkedRecordNames[id] : undefined))
          .filter(Boolean) as string[];
        if (resolved.length > 0) {
          if (resolved.length <= 3) return resolved.join(", ");
          return `${resolved.slice(0, 2).join(", ")} + ${resolved.length - 2} more`;
        }
      }
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
    return value.length > 100 ? value.slice(0, 97) + "..." : value;
  }
  return String(value);
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => v === b[i]);
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return false;
}

/** Check if a field can be union-merged (arrays or non-empty strings on both sides). */
function canCombine(a: unknown, b: unknown): boolean {
  if (isEmpty(a) || isEmpty(b)) return false;
  // Both arrays — can concat/dedupe
  if (Array.isArray(a) && Array.isArray(b)) return true;
  // Both non-empty strings — can join
  if (typeof a === "string" && typeof b === "string") return true;
  return false;
}

/** Combine two values into a union merge. */
function combineValues(a: unknown, b: unknown): unknown {
  if (Array.isArray(a) && Array.isArray(b)) {
    // Deduplicated union of both arrays
    const seen = new Set(a.map((v) => JSON.stringify(v)));
    const combined = [...a];
    for (const item of b) {
      const key = JSON.stringify(item);
      if (!seen.has(key)) {
        seen.add(key);
        combined.push(item);
      }
    }
    return combined;
  }
  if (typeof a === "string" && typeof b === "string") {
    if (a === b) return a;
    return `${a}; ${b}`;
  }
  // Fallback — return primary
  return a;
}

export function DuplicateMergeView({
  entity,
  primaryRecordId,
  secondaryRecordIds,
  onBack,
  onMergeComplete,
}: DuplicateMergeViewProps) {
  const allRecordIds = useMemo(
    () => [primaryRecordId, ...secondaryRecordIds],
    [primaryRecordId, secondaryRecordIds]
  );
  const {
    records,
    linkedRecordNames,
    loading: recordsLoading,
    error: recordsError,
    refetch,
  } = useAirtableRecords(entity, allRecordIds);
  const { schema } = useAirtableSchema();
  const {
    mergeRecords,
    loading: mergeLoading,
    error: mergeError,
    clearError,
  } = useRemediateActions();

  const [activeSecondaryIdx, setActiveSecondaryIdx] = useState(0);
  const [fieldSelections, setFieldSelections] = useState<FieldSelection>({});
  const [showPreview, setShowPreview] = useState(false);
  const [showMatchingFields, setShowMatchingFields] = useState(false);
  const [confirmState, setConfirmState] = useState<"merge" | null>(null);
  const [mergeSuccess, setMergeSuccess] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<number>>(new Set([2]));

  const primaryRecord = records[primaryRecordId];
  const activeSecondaryId = secondaryRecordIds[activeSecondaryIdx];
  const secondaryRecord = activeSecondaryId
    ? records[activeSecondaryId]
    : null;

  // Resolve the primary field value for each record (e.g. student name)
  const primaryFieldDisplays = useMemo(() => {
    if (!schema?.tables) return { primary: null, secondary: null };
    const normalized = normalizeEntityName(entity);
    for (const table of schema.tables) {
      const tableName = table.name?.toLowerCase().replace(/ /g, "_");
      if (
        tableName === normalized ||
        normalized.includes(tableName) ||
        tableName?.includes(normalized)
      ) {
        const fieldId = table.primaryFieldId;
        if (!fieldId) break;
        const field = table.fields?.find((f: any) => f.id === fieldId);
        if (!field) break;
        const extract = (rec: any) => {
          if (!rec) return null;
          const val = rec.fields[field.name];
          if (val && typeof val === "string") return val;
          if (Array.isArray(val) && val.length > 0) return String(val[0]);
          if (val != null) return String(val);
          return null;
        };
        return {
          primary: extract(primaryRecord),
          secondary: extract(secondaryRecord),
        };
      }
    }
    return { primary: null, secondary: null };
  }, [schema, entity, primaryRecord, secondaryRecord]);

  const primaryAirtableLink = useMemo(() => {
    return getAirtableLinksWithFallback(entity, primaryRecordId, schema);
  }, [entity, primaryRecordId, schema]);

  const secondaryAirtableLink = useMemo(() => {
    if (!activeSecondaryId) return null;
    return getAirtableLinksWithFallback(entity, activeSecondaryId, schema);
  }, [entity, activeSecondaryId, schema]);

  // Resolve field metadata from schema for this entity's table
  const fieldMeta = useMemo(() => {
    const meta: Record<string, { type: string; isComputed: boolean }> = {};
    if (!schema?.tables) return meta;
    const normalized = normalizeEntityName(entity);
    for (const table of schema.tables) {
      const tableName = table.name?.toLowerCase().replace(/ /g, "_");
      if (
        tableName === normalized ||
        normalized.includes(tableName) ||
        tableName?.includes(normalized)
      ) {
        for (const field of table.fields || []) {
          const computedTypes = new Set([
            "formula",
            "rollup",
            "lookup",
            "count",
            "autoNumber",
            "createdTime",
            "lastModifiedTime",
            "multipleLookupValues",
            "externalSyncSource",
            "aiText",
            "button",
            "createdBy",
            "lastModifiedBy",
          ]);
          meta[field.name] = {
            type: field.type,
            isComputed: computedTypes.has(field.type),
          };
        }
        break;
      }
    }
    return meta;
  }, [schema, entity]);

  // Critical fields that should appear first (editable, important identifiers)
  const criticalFieldPatterns = [
    /^entry\s*id$/i,
    /^full\s*name$/i,
    /^name$/i,
    /first\s*name/i,
    /legal\s*first/i,
    /last\s*name/i,
    /legal\s*last/i,
    /^email$/i,
    /email\s*address/i,
    /phone/i,
    /mobile/i,
    /birth\s*date/i,
    /birthdate/i,
    /date\s*of\s*birth/i,
    /dob/i,
    /^grade$/i,
    /grade\s*level/i,
    /^gender$/i,
    /^sex$/i,
    /^status$/i,
    /enrollment/i,
    /^type$/i,
    /^role$/i,
    /^address$/i,
    /street\s*address/i,
    /^city$/i,
    /^state$/i,
    /^zip/i,
    /school\s*year/i,
    /prefer.*name/i,
    /nick\s*name/i,
    /^date$/i,
    /^class$/i,
    /^subject$/i,
    /^title$/i,
  ];

  // Compute unified field list
  const fieldInfo = useMemo(() => {
    if (!primaryRecord || !secondaryRecord) return [];

    const allKeys = new Set<string>();
    Object.keys(primaryRecord.fields).forEach((k) => allKeys.add(k));
    Object.keys(secondaryRecord.fields).forEach((k) => allKeys.add(k));

    // Filter out internal fields
    const skipPatterns = [
      /zapier/i,
      /copy/i,
      /^created$/i,
      /^modified$/i,
      /today's date/i,
    ];

    return Array.from(allKeys)
      .filter((key) => !skipPatterns.some((p) => p.test(key)))
      .map((key) => {
        const pVal = primaryRecord.fields[key];
        const sVal = secondaryRecord.fields[key];
        const same = valuesEqual(pVal, sVal);
        const pEmpty = isEmpty(pVal);
        const sEmpty = isEmpty(sVal);
        const meta = fieldMeta[key];
        // Detect computed: from schema type OR by name pattern (fallback for unmatched fields)
        const computedNamePatterns = [
          /\(from\s/i,     // lookup fields: "Field (from Table)"
          /rollup/i,       // rollup fields
          /^autonumber$/i, // auto-number
          /^created time$/i,
          /^last modified/i,
        ];
        const isComputed = meta?.isComputed ?? computedNamePatterns.some((p) => p.test(key));
        const isCritical =
          !isComputed &&
          criticalFieldPatterns.some((p) => p.test(key));

        // Sort priority: 0 = critical editable, 1 = other editable, 2 = computed
        const sortGroup = isComputed ? 2 : isCritical ? 0 : 1;

        const combinable = !isComputed && canCombine(pVal, sVal);
        return { key, pVal, sVal, same, pEmpty, sEmpty, isComputed, isCritical, sortGroup, fieldType: meta?.type, combinable };
      })
      .sort((a, b) => {
        // First by group
        if (a.sortGroup !== b.sortGroup) return a.sortGroup - b.sortGroup;
        // Within same group, alphabetical
        return a.key.localeCompare(b.key);
      });
  }, [primaryRecord, secondaryRecord, fieldMeta]);

  // Effective selection for each field
  const getSelection = useCallback(
    (key: string, pEmpty: boolean, sEmpty: boolean): "primary" | "secondary" | "both" => {
      if (fieldSelections[key] !== undefined) return fieldSelections[key];
      // Default: prefer non-empty, otherwise primary
      if (pEmpty && !sEmpty) return "secondary";
      return "primary";
    },
    [fieldSelections]
  );

  // Compute merged fields (skip computed fields — they can't be written)
  const mergedFields = useMemo(() => {
    if (!primaryRecord || !secondaryRecord) return {};
    const fields: Record<string, unknown> = {};
    for (const f of fieldInfo) {
      if (f.isComputed) continue;
      const sel = getSelection(f.key, f.pEmpty, f.sEmpty);
      if (sel === "both") {
        fields[f.key] = combineValues(f.pVal, f.sVal);
      } else if (sel === "primary") {
        if (f.pVal !== undefined) fields[f.key] = f.pVal;
      } else {
        if (f.sVal !== undefined) fields[f.key] = f.sVal;
      }
    }
    return fields;
  }, [fieldInfo, getSelection, primaryRecord, secondaryRecord]);

  // Split into differing and matching fields
  const differingFields = useMemo(
    () => fieldInfo.filter((f) => !f.same),
    [fieldInfo]
  );
  const matchingFields = useMemo(
    () => fieldInfo.filter((f) => f.same),
    [fieldInfo]
  );
  const editableDiffCount = differingFields.filter((f) => !f.isComputed).length;
  const computedDiffCount = differingFields.filter((f) => f.isComputed).length;

  const handleSelectField = useCallback(
    (key: string, value: "primary" | "secondary" | "both") => {
      setFieldSelections((prev) => ({ ...prev, [key]: value }));
    },
    []
  );

  const handleSelectAllPrimary = useCallback(() => {
    const sel: FieldSelection = {};
    fieldInfo.forEach((f) => {
      if (!f.isComputed) sel[f.key] = "primary";
    });
    setFieldSelections(sel);
  }, [fieldInfo]);

  const handleSelectAllSecondary = useCallback(() => {
    const sel: FieldSelection = {};
    fieldInfo.forEach((f) => {
      if (!f.isComputed) sel[f.key] = "secondary";
    });
    setFieldSelections(sel);
  }, [fieldInfo]);

  const handleMerge = async () => {
    setConfirmState(null);
    clearError();
    try {
      await mergeRecords(
        entity,
        primaryRecordId,
        [activeSecondaryId],
        mergedFields
      );
      setMergeSuccess(true);
      // If there are more secondaries, move to next
      if (secondaryRecordIds.length > 1 && activeSecondaryIdx < secondaryRecordIds.length - 1) {
        setTimeout(() => {
          setActiveSecondaryIdx((prev) => prev + 1);
          setFieldSelections({});
          setShowPreview(false);
          setMergeSuccess(false);
          refetch();
        }, 1500);
      } else {
        setTimeout(() => onMergeComplete(), 1500);
      }
    } catch {
      // error is set in hook
    }
  };

  if (recordsLoading) {
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
          <p className="text-[var(--text-muted)]">Loading records from Airtable...</p>
        </div>
      </div>
    );
  }

  if (recordsError || !primaryRecord || !secondaryRecord) {
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
            {recordsError || "Could not load one or more records. They may have been deleted."}
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

      {/* Success banner */}
      {mergeSuccess && (
        <div className="rounded-xl border border-green-200 bg-green-50 p-4 text-sm text-green-800 font-medium">
          Merge completed successfully.
        </div>
      )}

      {/* Error banner */}
      {mergeError && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {mergeError}
        </div>
      )}

      {/* Secondary tabs for multi-record groups */}
      {secondaryRecordIds.length > 1 && (
        <div className="flex gap-2">
          {secondaryRecordIds.map((id, idx) => (
            <button
              key={id}
              onClick={() => {
                setActiveSecondaryIdx(idx);
                setFieldSelections({});
                setShowPreview(false);
              }}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                idx === activeSecondaryIdx
                  ? "bg-[var(--brand)] text-white"
                  : "bg-gray-100 text-[var(--text-muted)] hover:bg-gray-200"
              }`}
            >
              Duplicate #{idx + 1}
            </button>
          ))}
        </div>
      )}

      {/* Record identity cards */}
      {(primaryFieldDisplays.primary || primaryFieldDisplays.secondary) && (
        <div className="grid grid-cols-2 gap-4">
          <div className="rounded-2xl border border-[var(--border)] bg-white p-4 flex items-center gap-3">
            <div className="rounded-lg bg-[var(--brand)]/10 p-2">
              <span className="inline-block w-3 h-3 rounded-full bg-[var(--brand)]" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-[var(--text-muted)]">Primary Record</p>
              <p className="text-base font-semibold text-[var(--text-main)] truncate" style={{ fontFamily: "Outfit" }}>
                {primaryFieldDisplays.primary || "—"}
              </p>
              <p className="text-[10px] text-[var(--text-muted)] font-mono">{primaryRecordId}</p>
            </div>
            <a
              href={primaryAirtableLink.primary}
              target="_blank"
              rel="noopener noreferrer"
              className="shrink-0 inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-[#2D7FF9]/10 border border-[#2D7FF9]/25 text-xs font-semibold text-[#2D7FF9] hover:bg-[#2D7FF9]/20 transition-colors"
            >
              <img src={airtableLogo} alt="Airtable" className="w-4 h-4" />
              Open in Airtable
            </a>
          </div>
          <div className="rounded-2xl border border-[var(--border)] bg-white p-4 flex items-center gap-3">
            <div className="rounded-lg bg-orange-50 p-2">
              <span className="inline-block w-3 h-3 rounded-full bg-orange-400" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-[var(--text-muted)]">Duplicate Record</p>
              <p className="text-base font-semibold text-[var(--text-main)] truncate" style={{ fontFamily: "Outfit" }}>
                {primaryFieldDisplays.secondary || "—"}
              </p>
              <p className="text-[10px] text-[var(--text-muted)] font-mono">{activeSecondaryId}</p>
            </div>
            {secondaryAirtableLink && (
              <a
                href={secondaryAirtableLink.primary}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-[#2D7FF9]/10 border border-[#2D7FF9]/25 text-xs font-semibold text-[#2D7FF9] hover:bg-[#2D7FF9]/20 transition-colors"
              >
                <img src={airtableLogo} alt="Airtable" className="w-4 h-4" />
                Open in Airtable
              </a>
            )}
          </div>
        </div>
      )}

      {/* Comparison table */}
      <div className="rounded-2xl border border-[var(--border)] bg-white overflow-hidden">
        <div className="p-4 border-b border-[var(--border)] bg-gray-50/50">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-[var(--text-main)]" style={{ fontFamily: "Outfit" }}>
                Field Comparison
              </h3>
              <p className="text-xs text-[var(--text-muted)] mt-1">
                {editableDiffCount} editable field{editableDiffCount !== 1 ? "s" : ""} differ between records.{computedDiffCount > 0 && ` ${computedDiffCount} computed field${computedDiffCount !== 1 ? "s" : ""} also differ (read-only).`}
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleSelectAllPrimary}
                className="px-3 py-1.5 rounded-lg text-xs font-medium border border-[var(--brand)] text-[var(--brand)] hover:bg-[var(--brand)] hover:text-white transition-colors"
              >
                Keep All Primary
              </button>
              <button
                onClick={handleSelectAllSecondary}
                className="px-3 py-1.5 rounded-lg text-xs font-medium border border-orange-400 text-orange-500 hover:bg-orange-400 hover:text-white transition-colors"
              >
                Keep All Duplicate
              </button>
            </div>
          </div>
        </div>

        {/* Differing fields */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] bg-gray-50/30">
                <th className="px-4 py-2.5 text-left text-xs font-medium text-[var(--text-muted)] w-[20%]">
                  Field
                </th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-[var(--text-muted)] w-[40%]">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="inline-block w-2 h-2 rounded-full bg-[var(--brand)]" />
                    Primary
                  </span>
                </th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-[var(--text-muted)] w-[40%]">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="inline-block w-2 h-2 rounded-full bg-orange-400" />
                    Duplicate
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {differingFields.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-4 py-6 text-center text-xs text-[var(--text-muted)]">
                    All fields are identical between these records.
                  </td>
                </tr>
              )}
              {(() => {
                let lastGroup = -1;
                const groupLabels: Record<number, string> = {
                  0: "Key Fields",
                  1: "Other Fields",
                  2: "Computed Fields (read-only)",
                };
                const groupCounts: Record<number, number> = {};
                differingFields.forEach((f) => {
                  groupCounts[f.sortGroup] = (groupCounts[f.sortGroup] || 0) + 1;
                });
                return differingFields.map((f) => {
                  const sel = getSelection(f.key, f.pEmpty, f.sEmpty);
                  const isPrimarySelected = sel === "primary";
                  const isSecondarySelected = sel === "secondary";
                  const isBothSelected = sel === "both";
                  const showGroupHeader = f.sortGroup !== lastGroup;
                  const isCollapsed = collapsedGroups.has(f.sortGroup);
                  lastGroup = f.sortGroup;

                  return (
                    <Fragment key={f.key}>
                      {showGroupHeader && (
                        <tr
                          className="bg-gray-50/80 cursor-pointer select-none hover:bg-gray-100/60 transition-colors"
                          onClick={() =>
                            setCollapsedGroups((prev) => {
                              const next = new Set(prev);
                              if (next.has(f.sortGroup)) next.delete(f.sortGroup);
                              else next.add(f.sortGroup);
                              return next;
                            })
                          }
                        >
                          <td
                            colSpan={3}
                            className="px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]"
                          >
                            <span className="flex items-center gap-1.5">
                              <svg
                                className={`w-3 h-3 text-gray-400 transition-transform ${isCollapsed ? "-rotate-90" : ""}`}
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                              >
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                              </svg>
                              {f.sortGroup === 2 && (
                                <svg className="w-3 h-3 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                                </svg>
                              )}
                              {groupLabels[f.sortGroup] || "Fields"}
                              <span className="text-[9px] font-normal normal-case tracking-normal text-gray-400">
                                ({groupCounts[f.sortGroup]})
                              </span>
                            </span>
                          </td>
                        </tr>
                      )}
                      {!isCollapsed && (
                        <tr
                          className={`border-b border-[var(--border)] last:border-0 ${f.isComputed ? "opacity-60" : ""}`}
                        >
                          <td className="px-4 py-2.5 text-xs font-medium text-[var(--text-main)] break-words align-top">
                            <span>{f.key}</span>
                            {f.isComputed && f.fieldType && (
                              <span className="ml-1.5 inline-flex px-1.5 py-0.5 rounded text-[9px] font-medium bg-gray-100 text-gray-500">
                                {f.fieldType}
                              </span>
                            )}
                          </td>
                          {/* Primary value cell */}
                          <td className="px-4 py-2 align-top">
                            <div
                              className={`flex items-start justify-between gap-2 rounded-lg px-3 py-2 transition-colors ${
                                !f.isComputed && isPrimarySelected
                                  ? "bg-[var(--brand)]/10 ring-1 ring-[var(--brand)]/30"
                                  : ""
                              }`}
                            >
                              <span
                                className={`text-xs break-words ${
                                  f.pEmpty ? "italic text-gray-400" : "text-[var(--text-main)]"
                                } ${!f.isComputed && isPrimarySelected ? "font-medium" : ""}`}
                              >
                                {formatValue(f.pVal, linkedRecordNames)}
                              </span>
                              {!f.isComputed && (
                                <button
                                  onClick={() => handleSelectField(f.key, "primary")}
                                  className={`shrink-0 px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                                    isPrimarySelected
                                      ? "bg-[var(--brand)] text-white"
                                      : "border border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--brand)] hover:text-[var(--brand)]"
                                  }`}
                                >
                                  {isPrimarySelected ? "Kept" : "Keep"}
                                </button>
                              )}
                            </div>
                          </td>
                          {/* Secondary value cell */}
                          <td className="px-4 py-2 align-top">
                            <div className="space-y-1.5">
                              <div
                                className={`flex items-start justify-between gap-2 rounded-lg px-3 py-2 transition-colors ${
                                  !f.isComputed && isSecondarySelected
                                    ? "bg-orange-50 ring-1 ring-orange-300/50"
                                    : ""
                                }`}
                              >
                                <span
                                  className={`text-xs break-words ${
                                    f.sEmpty ? "italic text-gray-400" : "text-[var(--text-main)]"
                                  } ${!f.isComputed && isSecondarySelected ? "font-medium" : ""}`}
                                >
                                  {formatValue(f.sVal, linkedRecordNames)}
                                </span>
                                {!f.isComputed && (
                                  <button
                                    onClick={() => handleSelectField(f.key, "secondary")}
                                    className={`shrink-0 px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                                      isSecondarySelected
                                        ? "bg-orange-400 text-white"
                                        : "border border-[var(--border)] text-[var(--text-muted)] hover:border-orange-400 hover:text-orange-500"
                                    }`}
                                  >
                                    {isSecondarySelected ? "Kept" : "Keep"}
                                  </button>
                                )}
                              </div>
                              {/* Both / union merge option */}
                              {f.combinable && (
                                <button
                                  onClick={() => handleSelectField(f.key, "both")}
                                  className={`w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                                    isBothSelected
                                      ? "bg-violet-100 ring-1 ring-violet-300/50 text-violet-700"
                                      : "border border-dashed border-gray-300 text-[var(--text-muted)] hover:border-violet-400 hover:text-violet-600"
                                  }`}
                                >
                                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
                                  </svg>
                                  {isBothSelected ? "Combined" : "Combine Both"}
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                });
              })()}
            </tbody>
          </table>
        </div>

        {/* Matching fields - collapsible */}
        {matchingFields.length > 0 && (
          <div className="border-t border-[var(--border)]">
            <button
              onClick={() => setShowMatchingFields(!showMatchingFields)}
              className="w-full flex items-center justify-between px-4 py-3 text-xs text-[var(--text-muted)] hover:bg-gray-50/50 transition-colors"
            >
              <span className="font-medium">
                {matchingFields.length} matching field{matchingFields.length !== 1 ? "s" : ""} (identical values)
              </span>
              <svg
                className={`w-4 h-4 transition-transform ${showMatchingFields ? "rotate-180" : ""}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {showMatchingFields && (
              <table className="w-full text-sm">
                <tbody>
                  {matchingFields.map((f) => (
                    <tr
                      key={f.key}
                      className="border-t border-[var(--border)] opacity-60"
                    >
                      <td className="px-4 py-2 text-xs font-medium text-[var(--text-muted)] w-[20%]">
                        {f.key}
                      </td>
                      <td colSpan={2} className="px-4 py-2 text-xs text-[var(--text-muted)]">
                        {formatValue(f.pVal, linkedRecordNames)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {/* Preview + Actions */}
      <div className="rounded-2xl border border-[var(--border)] bg-white p-5">
        <div className="flex items-center justify-between mb-4">
          <button
            onClick={() => setShowPreview(!showPreview)}
            className="text-sm font-medium text-[var(--cta-blue)] hover:underline"
          >
            {showPreview ? "Hide" : "Preview"} Merged Result
          </button>
          <div className="flex gap-3">
            <button
              onClick={() => setConfirmState("merge")}
              disabled={mergeLoading || mergeSuccess}
              className="rounded-lg bg-[var(--brand)] px-5 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50 transition-colors"
            >
              {mergeLoading ? "Merging..." : "Merge & Delete Duplicate"}
            </button>
          </div>
        </div>

        {showPreview && (
          <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-mid)]/30 p-4 space-y-1.5">
            <p className="text-xs font-medium text-[var(--text-muted)] mb-2">
              Primary record will be updated with these values:
            </p>
            {Object.entries(mergedFields).map(([key, val]) => {
              const original = primaryRecord?.fields[key];
              const changed = !valuesEqual(original, val);
              const isCombined = fieldSelections[key] === "both";
              return (
                <div key={key} className="flex gap-2 text-xs">
                  <span className="text-[var(--text-muted)] min-w-[150px] shrink-0 truncate">
                    {key}:
                  </span>
                  <span
                    className={`${
                      isCombined
                        ? "text-violet-600 font-medium"
                        : changed
                          ? "text-[var(--brand)] font-medium"
                          : "text-[var(--text-main)]"
                    }`}
                  >
                    {formatValue(val, linkedRecordNames)}
                    {isCombined ? " (combined)" : changed ? " (changed)" : ""}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Record IDs reference */}
      <div className="text-xs text-[var(--text-muted)] flex gap-4">
        <span>Primary: <code className="font-mono">{primaryRecordId}</code></span>
        <span>Duplicate: <code className="font-mono">{activeSecondaryId}</code></span>
      </div>

      {/* Confirm Modal */}
      <ConfirmModal
        isOpen={confirmState === "merge"}
        title="Confirm Merge"
        message={`This will update the primary record (${primaryRecordId.slice(0, 8)}...) with your selected field values and permanently delete the duplicate record (${activeSecondaryId?.slice(0, 8)}...). This action cannot be undone.`}
        confirmLabel="Merge & Delete"
        isDestructive={true}
        onConfirm={handleMerge}
        onCancel={() => setConfirmState(null)}
      />
    </div>
  );
}
