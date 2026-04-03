import { useState, useMemo, useCallback, useRef, useEffect, Fragment } from "react";
import { createPortal } from "react-dom";
import { useAirtableRecords } from "../hooks/useAirtableRecords";
import { useAirtableSchema } from "../contexts/AirtableSchemaContext";
import { useRemediateActions } from "../hooks/useRemediateActions";
import { normalizeEntityName } from "../config/entities";
import { getAirtableLinksWithFallback } from "../utils/airtable";
import ConfirmModal from "./ConfirmModal";
import airtableLogo from "../assets/Airtable-Mark-Color.svg";

interface DuplicateMergeViewProps {
  /** Normalized entity key for Airtable APIs (e.g. students). */
  entity: string;
  /** Entity string stored on Firestore issues (often singular, e.g. student). */
  integrityEntity?: string;
  primaryRecordId: string;
  secondaryRecordIds: string[];
  onBack: () => void;
  onMergeComplete: () => void | Promise<void>;
  matchSeverity?: string;
  matchDescription?: string;
  matchRuleId?: string;
}

type FieldSelection = Record<string, "primary" | "secondary" | "both" | "custom">;

function formatValue(value: unknown, linkedRecordNames?: Record<string, string>): string {
  if (value === null || value === undefined || value === "") return "(empty)";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "(empty)";
    const isLinkedRecords =
      typeof value[0] === "string" && value[0].startsWith("rec");
    if (isLinkedRecords) {
      const resolved: string[] = [];
      let unresolvedCount = 0;
      for (const item of value) {
        if (typeof item !== "string") continue;
        const name = linkedRecordNames?.[item];
        if (name) {
          resolved.push(name);
        } else {
          unresolvedCount++;
        }
      }
      if (resolved.length > 0) {
        const shown = resolved.length <= 3
          ? resolved.join(", ")
          : `${resolved.slice(0, 2).join(", ")} + ${resolved.length - 2} more`;
        if (unresolvedCount > 0) {
          return `${shown} + ${unresolvedCount} unresolved`;
        }
        return shown;
      }
      return `${value.length} linked record${value.length !== 1 ? "s" : ""}`;
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

/** Format Airtable createdTime (ISO string) to Mountain time. */
function formatCreatedTimeMountain(createdTime?: string): string | null {
  if (!createdTime) return null;
  try {
    const date = new Date(createdTime);
    if (isNaN(date.getTime())) return null;
    return date.toLocaleString("en-US", {
      timeZone: "America/Denver",
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return null;
  }
}

const neverCombinePatterns = [
  /first\s*name/i, /legal\s*first/i,
  /middle\s*name/i, /^middle$/i,
  /last\s*name/i, /legal\s*last/i,
  /date\s*of\s*birth/i, /dob/i, /birth\s*date/i, /birthdate/i,
  /^gender$/i, /^sex$/i,
  /^email$/i, /email\s*address/i, /primary\s*email/i,
  /phone/i, /mobile/i, /cell/i,
  /enrollment\s*status/i, /^status$/i,
  /^grade$/i, /grade\s*level/i,
  /sis\s*id/i, /student\s*id/i, /truth\s*id/i,
  /^entry\s*id$/i,
  /^ssn$/i, /social\s*security/i,
];

const neverCombineFieldTypes = new Set([
  "singleSelect", "checkbox", "rating", "number",
  "currency", "percent", "date", "dateTime",
]);

/** Check if a field can be union-merged (arrays or non-empty strings on both sides). */
function canCombine(key: string, a: unknown, b: unknown, fieldType?: string): boolean {
  if (isEmpty(a) || isEmpty(b)) return false;
  if (neverCombinePatterns.some((p) => p.test(key))) return false;
  if (fieldType && neverCombineFieldTypes.has(fieldType)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return true;
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

const RULE_ID_LABELS: Record<string, string> = {
  "dup.student.name_dob": "Matching name and date of birth",
  "dup.student.name_only": "Similar name (no date of birth match)",
  "dup.student.phone_name": "Matching phone number with similar first and last name",
  "dup.parent.email": "Matching email address",
  "dup.parent.phone": "Matching phone number",
  "dup.parent.name_student": "Similar name and shared student",
  "dup.parent.address": "Matching address",
  "dup.contractor.email": "Matching email address",
  "dup.contractor.phone": "Matching phone number",
  "dup.contractor.name": "Similar name",
  // Plural `students` (Firestore / migrated rules) — same semantics as dup.student.*
  "dup.students.dob_name": "Matching first name and birthday",
  "dup.students.name_dob": "Matching name and date of birth",
  "dup.students.name_only": "Similar name (no date of birth match)",
  "dup.students.phone_name": "Matching phone number with similar first and last name",
};

/** User-facing explanation for duplicate rule_id (handles plural `dup.students.*`). */
function duplicateRuleLabel(ruleId: string | undefined): string | undefined {
  if (!ruleId) return undefined;
  if (RULE_ID_LABELS[ruleId]) return RULE_ID_LABELS[ruleId];
  const singular = ruleId.replace(/^dup\.students\./, "dup.student.");
  if (singular !== ruleId && RULE_ID_LABELS[singular]) return RULE_ID_LABELS[singular];
  return undefined;
}

/** Sentence fragment after "Flagged as … duplicates " (starts with "because "). */
function duplicateReasonBannerText(
  matchRuleId: string | undefined,
  matchDescription: string | undefined,
  isGenericDesc: boolean
): string {
  const human = duplicateRuleLabel(matchRuleId);
  const ofHuman = human
    ? `because of ${human.charAt(0).toLowerCase() + human.slice(1)}`
    : undefined;
  if (isGenericDesc) {
    return ofHuman || (matchRuleId ? `because: ${matchRuleId}` : matchDescription || "");
  }
  if (matchDescription) return `because ${matchDescription}`;
  return ofHuman || (matchRuleId ? `because: ${matchRuleId}` : "");
}

const FIELD_CATEGORIES: { label: string; patterns: RegExp[] }[] = [
  // First: emergency / pickup-authorization fields must win over generic /phone/i in Contact.
  {
    label: "Emergency Contact & Medical Information",
    patterns: [
      /\bemergency\b/i,
      /emergency\s*contact/i,
      /guardian/i,
      // Authorized pickup persons (Airtable: "Approved Name #N", phones, pickup flags)
      /approved\s*name/i,
      /approved.*phone/i,
      /approved.*pickup/i,
      /isapproved.*pickup/i,
      /can\s*pickup/i,
      /pickup\s*student/i,
      /authorize\s*pickup/i,
      /^medical$/i,
      /allerg/i,
      /medication/i,
      /health/i,
      /immuniz/i,
      /vaccine/i,
    ],
  },
  {
    label: "Contact & Student Information",
    patterns: [
      /^entry\s*id$/i, /^full\s*name$/i, /^name$/i, /first\s*name/i, /legal\s*first/i,
      /last\s*name/i, /legal\s*last/i, /^middle/i, /suffix/i, /^preferred\s*name/i,
      /nick\s*name/i, /birth\s*date/i, /birthdate/i, /date\s*of\s*birth/i, /dob/i,
      /^gender$/i, /^sex$/i, /sis\s*id/i, /student\s*id/i, /truth\s*id/i, /^ssn$/i,
      /social\s*security/i, /^photo$/i, /photo.*release/i, /t-?shirt/i,
      /^email$/i, /email\s*address/i, /primary\s*email/i, /parent.*email/i,
      /phone/i, /mobile/i, /cell/i, /sms/i,
      /^primary\s*address/i, /^secondary\s*address/i, /street\s*address/i, /^address/i,
      /parent.*address/i, /parent.*city/i, /parent.*state/i, /parent.*zip/i,
      /^city/i, /^state/i, /^zip/i, /^country/i, /postal/i, /mailing/i,
      /contact\s*info/i, /can\s*(email|text)/i,
      /prefere?d\s*name/i,
      /ethnicit/i, /hispanic/i, /latino/i, /race/i,
      /language/i, /speak.*language/i, /first.*speak/i,
      /homeless/i, /military/i, /immigrant/i,
    ],
  },
  {
    label: "Enrollment Information",
    patterns: [
      /enrollment/i, /^status$/i, /^grade$/i, /grade\s*level/i, /school\s*year/i,
      /^type$/i, /^role$/i, /^class$/i, /^subject$/i, /^title$/i, /^date$/i,
      /^program/i, /^section/i, /^cohort/i,
    ],
  },
];

const CATEGORY_COMPUTED = "Computed Fields";
const CATEGORY_OTHER = "Other";

const CATEGORY_ORDER = [
  ...FIELD_CATEGORIES.map((c) => c.label),
  CATEGORY_OTHER,
  CATEGORY_COMPUTED,
];

function categorizeField(key: string, isComputed: boolean): string {
  if (isComputed) return CATEGORY_COMPUTED;
  for (const cat of FIELD_CATEGORIES) {
    if (cat.patterns.some((p) => p.test(key))) return cat.label;
  }
  return CATEGORY_OTHER;
}

/** Tiny link icon; hover shows a tooltip (Airtable linked record field). Portal avoids table overflow clipping. */
function LinkedRecordFieldHint() {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [show, setShow] = useState(false);
  const [coords, setCoords] = useState({ top: 0, left: 0 });

  const measure = useCallback(() => {
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setCoords({ top: r.top, left: r.left + r.width / 2 });
  }, []);

  useEffect(() => {
    if (!show) return;
    measure();
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [show, measure]);

  return (
    <>
      <span
        ref={anchorRef}
        className="relative shrink-0 inline-flex self-center cursor-help"
        onMouseEnter={() => {
          measure();
          setShow(true);
        }}
        onMouseLeave={() => setShow(false)}
        aria-label="Linked record field in Airtable"
      >
        <svg
          className="w-3 h-3 text-gray-400 hover:text-[var(--cta-blue)] transition-colors"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
          />
        </svg>
      </span>
      {show &&
        createPortal(
          <span
            role="tooltip"
            className="fixed z-[100] w-max max-w-[min(240px,calc(100vw-2rem))] px-2 py-1.5 text-[10px] leading-snug font-normal text-gray-700 bg-white border border-gray-200 rounded-md shadow-md text-center pointer-events-none"
            style={{
              top: coords.top,
              left: coords.left,
              transform: "translate(-50%, calc(-100% - 6px))",
            }}
          >
            This is a linked record field in Airtable.
          </span>,
          document.body
        )}
    </>
  );
}

export function DuplicateMergeView({
  entity,
  integrityEntity: integrityEntityProp,
  primaryRecordId,
  secondaryRecordIds,
  onBack,
  onMergeComplete,
  matchSeverity,
  matchDescription,
  matchRuleId,
}: DuplicateMergeViewProps) {
  const integrityEntity = integrityEntityProp ?? entity;

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
    dismissDuplicate,
    loading: mergeLoading,
    error: mergeError,
    clearError,
  } = useRemediateActions();

  const [activeSecondaryIdx, setActiveSecondaryIdx] = useState(0);
  const [fieldSelections, setFieldSelections] = useState<FieldSelection>({});
  const [customValues, setCustomValues] = useState<Record<string, string>>({});
  const [editingCustomField, setEditingCustomField] = useState<string | null>(null);
  const [customDraft, setCustomDraft] = useState("");
  const [showPreview, setShowPreview] = useState(false);
  const [showMatchingFields, setShowMatchingFields] = useState(false);
  const [confirmState, setConfirmState] = useState<"merge" | "dismiss" | null>(null);
  const [mergeSuccess, setMergeSuccess] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set([CATEGORY_COMPUTED]));

  // Re-derive original vs new based on createdTime so the oldest record is
  // always shown as "Original" regardless of what the backend assigned.
  const { resolvedPrimaryId, resolvedSecondaryIds } = useMemo(() => {
    const all = [primaryRecordId, ...secondaryRecordIds];
    const loaded = all.filter((id) => records[id]?.createdTime);
    if (loaded.length < 2) {
      return { resolvedPrimaryId: primaryRecordId, resolvedSecondaryIds: secondaryRecordIds };
    }
    const sorted = [...all].sort((a, b) => {
      const tA = records[a]?.createdTime ? new Date(records[a].createdTime!).getTime() : Infinity;
      const tB = records[b]?.createdTime ? new Date(records[b].createdTime!).getTime() : Infinity;
      return tA - tB;
    });
    const [oldest, ...rest] = sorted;
    return { resolvedPrimaryId: oldest, resolvedSecondaryIds: rest };
  }, [primaryRecordId, secondaryRecordIds, records]);

  const primaryRecord = records[resolvedPrimaryId];
  const activeSecondaryId = resolvedSecondaryIds[activeSecondaryIdx];
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
    return getAirtableLinksWithFallback(entity, resolvedPrimaryId, schema);
  }, [entity, resolvedPrimaryId, schema]);

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

  // Compute unified field list with category assignment
  const fieldInfo = useMemo(() => {
    if (!primaryRecord || !secondaryRecord) return [];

    const allKeys = new Set<string>();
    Object.keys(primaryRecord.fields).forEach((k) => allKeys.add(k));
    Object.keys(secondaryRecord.fields).forEach((k) => allKeys.add(k));

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
        const computedNamePatterns = [
          /\(from\s/i,
          /rollup/i,
          /^autonumber$/i,
          /^created time$/i,
          /^last modified/i,
        ];
        const isComputed = meta?.isComputed ?? computedNamePatterns.some((p) => p.test(key));
        const category = categorizeField(key, isComputed);
        const combinable = !isComputed && canCombine(key, pVal, sVal, meta?.type);

        const isLinkedRecordField = meta?.type === "multipleRecordLinks";
        const isStandardCustomTextType =
          !meta?.type ||
          ["singleLineText", "multilineText", "richText", "email", "phoneNumber", "url"].includes(
            meta.type
          );
        // Any combinable non-link field can use custom write (covers e.g. long text types not in the list).
        const supportsCustomWrite =
          !isComputed &&
          !isLinkedRecordField &&
          (isStandardCustomTextType || combinable);

        return {
          key,
          pVal,
          sVal,
          same,
          pEmpty,
          sEmpty,
          isComputed,
          category,
          fieldType: meta?.type,
          combinable,
          supportsCustomWrite,
        };
      })
      .sort((a, b) => {
        const aIdx = CATEGORY_ORDER.indexOf(a.category);
        const bIdx = CATEGORY_ORDER.indexOf(b.category);
        if (aIdx !== bIdx) return aIdx - bIdx;
        return a.key.localeCompare(b.key);
      });
  }, [primaryRecord, secondaryRecord, fieldMeta]);

  // Fields where the newer record's data is more likely to be current.
  const preferNewRecordPatterns = [
    // Contact names & approved pickups
    /approved\s*name/i,
    /approved.*phone/i,
    /approved.*pickup/i,
    /prefere?d\s*name/i,
    // Email
    /email/i,
    // Phone
    /phone/i,
    /cell\s*phone/i,
    /mobile/i,
    /sms/i,
    // Addresses
    /^primary\s*address/i,
    /^secondary\s*address/i,
    /street\s*address/i,
    /^address/i,
    /parent.*address/i,
    /parent.*city/i,
    /parent.*state/i,
    /parent.*zip/i,
    /^city/i,
    /^state/i,
    /^zip/i,
    /^country/i,
    /postal/i,
    /mailing/i,
    // Emergency contacts
    /emergency\s*contact/i,
    /guardian/i,
    /can\s*(email|text)/i,
    /contact\s*info/i,
    // Ethnicity & race
    /ethnicit/i,
    /hispanic/i,
    /latino/i,
    /race/i,
    // Language
    /language/i,
    /speak.*language/i,
    /first.*speak/i,
    // Homeless / military / immigrant status
    /homeless/i,
    /military/i,
    /immigrant/i,
    // T-shirt size
    /t-?shirt/i,
    // Photo release
    /^photo$/i,
    /photo.*release/i,
    // Medical
    /^medical$/i,
  ];

  // Effective selection for each field
  const getSelection = useCallback(
    (key: string, pEmpty: boolean, sEmpty: boolean): "primary" | "secondary" | "both" | "custom" => {
      if (fieldSelections[key] !== undefined) return fieldSelections[key];
      if (pEmpty && !sEmpty) return "secondary";
      if (sEmpty && !pEmpty) return "primary";
      const meta = fieldMeta[key];
      if (meta?.type === "multipleRecordLinks" && !pEmpty && !sEmpty) return "both";
      if (!pEmpty && !sEmpty && preferNewRecordPatterns.some((p) => p.test(key))) {
        return "secondary";
      }
      return "primary";
    },
    [fieldSelections, fieldMeta]
  );

  // Compute merged fields (skip computed fields — they can't be written)
  const mergedFields = useMemo(() => {
    if (!primaryRecord || !secondaryRecord) return {};
    const fields: Record<string, unknown> = {};
    for (const f of fieldInfo) {
      if (f.isComputed) continue;
      const sel = getSelection(f.key, f.pEmpty, f.sEmpty);
      if (sel === "custom" && customValues[f.key] !== undefined) {
        fields[f.key] = customValues[f.key];
      } else if (sel === "both") {
        fields[f.key] = combineValues(f.pVal, f.sVal);
      } else if (sel === "primary") {
        if (f.pVal !== undefined) fields[f.key] = f.pVal;
      } else {
        if (f.sVal !== undefined) fields[f.key] = f.sVal;
      }
    }
    return fields;
  }, [fieldInfo, getSelection, primaryRecord, secondaryRecord, customValues]);

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

  // Group differing fields by category for rendering
  const groupedDifferingFields = useMemo(() => {
    const groups: { category: string; fields: typeof differingFields }[] = [];
    let currentCat = "";
    for (const f of differingFields) {
      if (f.category !== currentCat) {
        currentCat = f.category;
        groups.push({ category: currentCat, fields: [] });
      }
      groups[groups.length - 1].fields.push(f);
    }
    return groups;
  }, [differingFields]);

  const handleSelectField = useCallback(
    (key: string, value: "primary" | "secondary" | "both" | "custom") => {
      setFieldSelections((prev) => ({ ...prev, [key]: value }));
    },
    []
  );

  const handleStartCustom = useCallback((key: string, currentVal?: unknown) => {
    setEditingCustomField(key);
    setCustomDraft(typeof currentVal === "string" ? currentVal : "");
  }, []);

  const handleConfirmCustom = useCallback((key: string) => {
    setCustomValues((prev) => ({ ...prev, [key]: customDraft }));
    setFieldSelections((prev) => ({ ...prev, [key]: "custom" }));
    setEditingCustomField(null);
    setCustomDraft("");
  }, [customDraft]);

  const handleCancelCustom = useCallback(() => {
    setEditingCustomField(null);
    setCustomDraft("");
  }, []);

  /** String merges become a custom value; linked-record arrays still use the "both" merge path. */
  const handleCombineOriginalAndNew = useCallback((key: string, pVal: unknown, sVal: unknown) => {
    const combined = combineValues(pVal, sVal);
    if (Array.isArray(combined)) {
      setFieldSelections((prev) => ({ ...prev, [key]: "both" }));
      return;
    }
    if (typeof combined === "string") {
      setCustomValues((prev) => ({ ...prev, [key]: combined }));
      setFieldSelections((prev) => ({ ...prev, [key]: "custom" }));
      setEditingCustomField(null);
      setCustomDraft("");
      return;
    }
    setFieldSelections((prev) => ({ ...prev, [key]: "both" }));
  }, []);

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

  const [mergePartialWarning, setMergePartialWarning] = useState<string | null>(null);

  const handleMerge = async () => {
    setConfirmState(null);
    clearError();
    setMergePartialWarning(null);
    try {
      const result = await mergeRecords(
        entity,
        resolvedPrimaryId,
        [activeSecondaryId],
        mergedFields
      );
      if (result.errors && result.errors.length > 0) {
        setMergePartialWarning(
          `Merge partially completed: the original record was updated, but the new record (${activeSecondaryId?.slice(0, 8)}...) could not be deleted. ` +
          `Please delete it manually in Airtable. Error: ${result.errors.map((e: { error: string }) => e.error).join("; ")}`
        );
        return;
      }
      setMergeSuccess(true);
      if (resolvedSecondaryIds.length > 1 && activeSecondaryIdx < resolvedSecondaryIds.length - 1) {
        setTimeout(() => {
          setActiveSecondaryIdx((prev) => prev + 1);
          setFieldSelections({});
          setCustomValues({});
          setEditingCustomField(null);
          setShowPreview(false);
          setMergeSuccess(false);
          setMergePartialWarning(null);
          refetch();
        }, 1500);
      } else {
        setTimeout(() => onMergeComplete(), 1500);
      }
    } catch {
      // error is set in hook
    }
  };

  const handleDismiss = async () => {
    setConfirmState(null);
    clearError();
    try {
      await dismissDuplicate(integrityEntity, [
        resolvedPrimaryId,
        ...resolvedSecondaryIds,
      ]);
      onMergeComplete();
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
    const missingIds = allRecordIds.filter((id) => !records[id]);
    const loadedIds = allRecordIds.filter((id) => records[id]);

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
        <div className="rounded-2xl border border-red-200 bg-red-50 p-6 space-y-4">
          <div>
            <p className="text-sm font-medium text-red-800 mb-2">
              {recordsError || "Could not load one or more records. They may have been deleted from Airtable."}
            </p>
            {missingIds.length > 0 && (
              <div className="mt-2 space-y-1">
                <p className="text-xs font-medium text-red-700">Missing record{missingIds.length > 1 ? "s" : ""}:</p>
                {missingIds.map((id) => (
                  <p key={id} className="text-xs text-red-600 font-mono bg-red-100 rounded px-2 py-1 inline-block mr-2">
                    {id}
                  </p>
                ))}
              </div>
            )}
            {loadedIds.length > 0 && (
              <p className="text-xs text-red-600 mt-2">
                {loadedIds.length} of {allRecordIds.length} record{allRecordIds.length > 1 ? "s" : ""} still exist{loadedIds.length === 1 ? "s" : ""}.
              </p>
            )}
          </div>
          <div className="flex gap-3 pt-2 border-t border-red-200">
            <button
              onClick={async () => {
                try {
                  await Promise.resolve(onMergeComplete());
                } catch (err) {
                  console.error("Failed to remove issue:", err);
                }
              }}
              className="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors"
            >
              Remove Issue
            </button>
            <button
              onClick={onBack}
              className="px-4 py-2 text-sm font-medium text-red-700 bg-red-100 hover:bg-red-200 rounded-lg transition-colors"
            >
              Go Back
            </button>
          </div>
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

      {/* Match reason */}
      {(matchSeverity || matchDescription || matchRuleId) && (() => {
        const isGenericDesc = Boolean(
          matchDescription && /duplicate group with \d+ records/i.test(matchDescription)
        );
        const reasonText = duplicateReasonBannerText(
          matchRuleId,
          matchDescription,
          isGenericDesc
        );
        return (
          <div className={`rounded-xl border px-4 py-3 text-sm ${
            matchSeverity === "warning"
              ? "border-amber-200 bg-amber-50/60"
              : "border-blue-200 bg-blue-50/60"
          }`}>
            <div className="flex items-start gap-2">
              <svg className={`w-4 h-4 shrink-0 mt-0.5 ${
                matchSeverity === "warning" ? "text-amber-500" : "text-blue-500"
              }`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div>
                <span className={`font-medium ${
                  matchSeverity === "warning" ? "text-amber-800" : "text-blue-800"
                }`}>
                  Flagged as {matchSeverity === "warning" ? "likely" : "possible"} duplicates{" "}
                </span>
                <span className={
                  matchSeverity === "warning" ? "text-amber-700" : "text-blue-700"
                }>
                  {reasonText}
                </span>
              </div>
            </div>
          </div>
        );
      })()}

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

      {/* Partial failure warning */}
      {mergePartialWarning && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          <span className="font-medium">Warning: </span>{mergePartialWarning}
        </div>
      )}

      {/* Secondary tabs for multi-record groups */}
      {resolvedSecondaryIds.length > 1 && (
        <div className="flex gap-2">
          {resolvedSecondaryIds.map((id, idx) => (
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
              New #{idx + 1}
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
              <p className="text-xs font-medium text-[var(--text-muted)]">
                Original Record
                {formatCreatedTimeMountain(primaryRecord?.createdTime) && (
                  <span className="ml-1.5 font-normal text-[var(--text-muted)]/80">
                    · {formatCreatedTimeMountain(primaryRecord?.createdTime)}
                  </span>
                )}
              </p>
              <p className="text-base font-semibold text-[var(--text-main)] truncate" style={{ fontFamily: "Outfit" }}>
                {primaryFieldDisplays.primary || "—"}
              </p>
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
              <p className="text-xs font-medium text-[var(--text-muted)]">
                New Record
                {secondaryRecord && formatCreatedTimeMountain(secondaryRecord?.createdTime) && (
                  <span className="ml-1.5 font-normal text-[var(--text-muted)]/80">
                    · {formatCreatedTimeMountain(secondaryRecord?.createdTime)}
                  </span>
                )}
              </p>
              <p className="text-base font-semibold text-[var(--text-main)] truncate" style={{ fontFamily: "Outfit" }}>
                {primaryFieldDisplays.secondary || "—"}
              </p>
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
                Select all original values
              </button>
              <button
                onClick={handleSelectAllSecondary}
                className="px-3 py-1.5 rounded-lg text-xs font-medium border border-orange-400 text-orange-500 hover:bg-orange-400 hover:text-white transition-colors"
              >
                Select all new values
              </button>
            </div>
          </div>
        </div>

        {/* Differing fields */}
        <div>
          <table className="w-full text-sm table-fixed">
            <thead>
              <tr className="border-b border-[var(--border)] bg-gray-50/30">
                <th className="px-3 py-2.5 text-left text-xs font-medium text-[var(--text-muted)]" style={{ width: "18%" }}>
                  Field
                </th>
                <th className="px-3 py-2.5 text-left text-xs font-medium text-[var(--text-muted)]" style={{ width: "30%" }}>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="inline-block w-2 h-2 rounded-full bg-[var(--brand)]" />
                    Original
                  </span>
                </th>
                <th className="px-3 py-2.5 text-left text-xs font-medium text-[var(--text-muted)]" style={{ width: "30%" }}>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="inline-block w-2 h-2 rounded-full bg-orange-400" />
                    New
                  </span>
                </th>
                <th className="px-3 py-2.5 text-left text-xs font-medium text-[var(--text-muted)]" style={{ width: "22%" }}>
                  <span className="inline-flex items-center gap-1.5">
                    <svg className="w-3 h-3 text-teal-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                    </svg>
                    Custom
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {differingFields.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-3 py-6 text-center text-xs text-[var(--text-muted)]">
                    All fields are identical between these records.
                  </td>
                </tr>
              )}
              {groupedDifferingFields.map((group) => {
                const isCollapsed = collapsedGroups.has(group.category);
                const isComputedGroup = group.category === CATEGORY_COMPUTED;
                return (
                  <Fragment key={group.category}>
                    <tr
                      className={`cursor-pointer select-none transition-colors ${
                        isComputedGroup
                          ? "bg-gray-100 hover:bg-gray-200/70 border-t-2 border-t-gray-300"
                          : "bg-[var(--brand)]/5 hover:bg-[var(--brand)]/10 border-t-2 border-t-[var(--brand)]/20"
                      }`}
                      onClick={() =>
                        setCollapsedGroups((prev) => {
                          const next = new Set(prev);
                          if (next.has(group.category)) next.delete(group.category);
                          else next.add(group.category);
                          return next;
                        })
                      }
                    >
                      <td
                        colSpan={4}
                        className="px-4 py-2.5"
                      >
                        <span className="flex items-center gap-2">
                          <svg
                            className={`w-3.5 h-3.5 transition-transform ${
                              isComputedGroup ? "text-gray-400" : "text-[var(--brand)]"
                            } ${isCollapsed ? "-rotate-90" : ""}`}
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                          </svg>
                          {isComputedGroup && (
                            <svg className="w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                            </svg>
                          )}
                          <span className={`text-xs font-semibold tracking-wide ${
                            isComputedGroup ? "text-gray-500" : "text-[var(--text-main)]"
                          }`}>
                            {group.category}
                          </span>
                          <span className="text-[10px] font-medium text-gray-400">
                            {group.fields.length} field{group.fields.length !== 1 ? "s" : ""}
                          </span>
                          {isComputedGroup && (
                            <span className="text-[10px] italic text-gray-400">— read-only</span>
                          )}
                        </span>
                      </td>
                    </tr>
                    {!isCollapsed && group.fields.map((f) => {
                      const sel = getSelection(f.key, f.pEmpty, f.sEmpty);
                      const isPrimarySelected = sel === "primary";
                      const isSecondarySelected = sel === "secondary";
                      const isBothSelected = sel === "both";
                      const isCustomSelected = sel === "custom";
                      const isEditingThis = editingCustomField === f.key;

                      return (
                        <tr
                          key={f.key}
                          className={`border-b border-[var(--border)] last:border-0 ${f.isComputed ? "opacity-60" : ""}`}
                        >
                          <td className="px-3 py-2.5 text-xs font-medium text-[var(--text-main)] align-top overflow-hidden">
                            <span className="inline-flex items-start gap-1 flex-wrap min-w-0">
                              <span className="break-words min-w-0">{f.key}</span>
                              {f.fieldType === "multipleRecordLinks" && <LinkedRecordFieldHint />}
                            </span>
                            {f.isComputed && f.fieldType && (
                              <span className="ml-1 inline-flex px-1 py-0.5 rounded text-[9px] font-medium bg-gray-100 text-gray-500">
                                {f.fieldType}
                              </span>
                            )}
                          </td>
                          {/* Primary value cell */}
                          <td className="px-3 py-2 align-top overflow-hidden">
                            <div
                              className={`flex items-start justify-between gap-1.5 rounded-lg px-2.5 py-2 transition-colors ${
                                !f.isComputed && isPrimarySelected
                                  ? "bg-[var(--brand)]/10 ring-1 ring-[var(--brand)]/30"
                                  : ""
                              }`}
                            >
                              <span
                                className={`text-xs break-words min-w-0 ${
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
                          <td className="px-3 py-2 align-top overflow-hidden">
                            <div
                              className={`flex items-start justify-between gap-1.5 rounded-lg px-2.5 py-2 transition-colors ${
                                !f.isComputed && isSecondarySelected
                                  ? "bg-orange-50 ring-1 ring-orange-300/50"
                                  : ""
                              }`}
                            >
                              <span
                                className={`text-xs break-words min-w-0 ${
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
                          </td>
                          {/* Custom value cell */}
                          <td className="px-3 py-2 align-top overflow-hidden">
                            {!f.isComputed && (f.supportsCustomWrite || f.combinable) && (
                              <div className="space-y-1.5">
                                {f.supportsCustomWrite && (
                                  <>
                                    {isEditingThis ? (
                                      <div className="rounded-lg border border-teal-300 bg-teal-50 p-2 space-y-1.5">
                                        <input
                                          type="text"
                                          autoFocus
                                          value={customDraft}
                                          onChange={(e) => setCustomDraft(e.target.value)}
                                          onKeyDown={(e) => {
                                            if (e.key === "Enter") handleConfirmCustom(f.key);
                                            if (e.key === "Escape") handleCancelCustom();
                                          }}
                                          className="w-full text-xs bg-white border border-gray-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-teal-400"
                                          placeholder="Enter custom value..."
                                        />
                                        <div className="flex gap-1">
                                          <button
                                            onClick={() => handleConfirmCustom(f.key)}
                                            className="flex-1 px-2 py-0.5 rounded text-xs font-medium bg-teal-600 text-white hover:bg-teal-700 transition-colors"
                                          >
                                            Save
                                          </button>
                                          <button
                                            onClick={handleCancelCustom}
                                            className="flex-1 px-2 py-0.5 rounded text-xs font-medium border border-gray-300 text-gray-500 hover:bg-gray-100 transition-colors"
                                          >
                                            Cancel
                                          </button>
                                        </div>
                                      </div>
                                    ) : isCustomSelected ? (
                                      <div
                                        onClick={() => handleStartCustom(f.key, customValues[f.key])}
                                        className="rounded-lg bg-teal-100 ring-1 ring-teal-300/50 px-2.5 py-2 cursor-pointer hover:bg-teal-200/70 transition-colors"
                                      >
                                        <span className="text-xs font-medium text-teal-700 break-words">
                                          {customValues[f.key]?.slice(0, 50)}{(customValues[f.key]?.length ?? 0) > 50 ? "..." : ""}
                                        </span>
                                        <span className="block text-[9px] text-teal-500 mt-0.5">Click to edit</span>
                                      </div>
                                    ) : (
                                      <button
                                        onClick={() => {
                                          const base = isSecondarySelected ? f.sVal : f.pVal;
                                          handleStartCustom(f.key, base);
                                        }}
                                        className="w-full flex items-center justify-center gap-1.5 px-2.5 py-2 rounded-lg text-xs font-medium border border-dashed border-gray-300 text-[var(--text-muted)] hover:border-teal-400 hover:text-teal-600 transition-colors"
                                      >
                                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                                        </svg>
                                    Custom value
                                  </button>
                                    )}
                                  </>
                                )}
                                {f.combinable && (
                                  <button
                                    type="button"
                                    onClick={() => handleCombineOriginalAndNew(f.key, f.pVal, f.sVal)}
                                    className={`w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                                      isBothSelected
                                        ? "bg-violet-100 ring-1 ring-violet-300/50 text-violet-700"
                                        : "border border-dashed border-gray-300 text-[var(--text-muted)] hover:border-violet-400 hover:text-violet-600"
                                    }`}
                                  >
                                    <svg className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
                                    </svg>
                                    {isBothSelected ? "Combined" : "Combine original and new"}
                                  </button>
                                )}
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </Fragment>
                );
              })}
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
              <table className="w-full text-sm table-fixed">
                <tbody>
                  {matchingFields.map((f) => (
                    <tr
                      key={f.key}
                      className="border-t border-[var(--border)] opacity-60"
                    >
                      <td className="px-3 py-2 text-xs font-medium text-[var(--text-muted)] overflow-hidden" style={{ width: "18%" }}>
                        <span className="inline-flex items-start gap-1 flex-wrap min-w-0">
                          <span className="break-words min-w-0">{f.key}</span>
                          {f.fieldType === "multipleRecordLinks" && <LinkedRecordFieldHint />}
                        </span>
                      </td>
                      <td colSpan={3} className="px-3 py-2 text-xs text-[var(--text-muted)] overflow-hidden">
                        <span className="break-words">{formatValue(f.pVal, linkedRecordNames)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="rounded-2xl border border-[var(--border)] bg-white p-5">
        {/* Change summary */}
        {(() => {
          const changeCount = differingFields.filter(
            (f) => !f.isComputed && getSelection(f.key, f.pEmpty, f.sEmpty) === "secondary"
          ).length;
          const combineCount = differingFields.filter(
            (f) => !f.isComputed && getSelection(f.key, f.pEmpty, f.sEmpty) === "both"
          ).length;
          const customCount = differingFields.filter(
            (f) => !f.isComputed && getSelection(f.key, f.pEmpty, f.sEmpty) === "custom"
          ).length;
          const keepCount = differingFields.filter(
            (f) => !f.isComputed && getSelection(f.key, f.pEmpty, f.sEmpty) === "primary"
          ).length;
          return (changeCount > 0 || combineCount > 0 || customCount > 0) ? (
            <p className="text-xs text-[var(--text-muted)] mb-3">
              <span className="font-medium">{keepCount}</span> field{keepCount !== 1 ? "s" : ""} kept from original
              {changeCount > 0 && <>, <span className="font-medium text-orange-600">{changeCount}</span> updated from new</>}
              {combineCount > 0 && <>, <span className="font-medium text-violet-600">{combineCount}</span> combined</>}
              {customCount > 0 && <>, <span className="font-medium text-teal-600">{customCount}</span> custom</>}
            </p>
          ) : null;
        })()}
        <div className="flex items-center justify-between">
          <button
            onClick={() => setConfirmState("dismiss")}
            disabled={mergeLoading || mergeSuccess}
            className="rounded-lg border border-red-400 px-5 py-2 text-sm font-medium text-red-600 hover:bg-red-50 hover:border-red-500 disabled:opacity-50 transition-colors"
          >
            Not a Duplicate
          </button>
          <button
            onClick={() => setShowPreview(!showPreview)}
            disabled={mergeLoading || mergeSuccess}
            className="rounded-lg bg-[var(--brand)] px-6 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50 transition-colors"
          >
            {showPreview ? "Hide" : "Preview"} Merged Result
          </button>
        </div>

        {showPreview && (
          <div className="mt-4 space-y-4">
            {/* Legend */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px]">
              <span className="text-[var(--text-muted)] font-medium uppercase tracking-wider">Source:</span>
              <span className="inline-flex items-center gap-1">
                <span className="inline-block w-2.5 h-2.5 rounded-sm bg-[var(--brand)]/15 ring-1 ring-[var(--brand)]/30" />
                <span className="text-[var(--text-muted)]">Original record</span>
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="inline-block w-2.5 h-2.5 rounded-sm bg-orange-100 ring-1 ring-orange-300/50" />
                <span className="text-[var(--text-muted)]">New record</span>
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="inline-block w-2.5 h-2.5 rounded-sm bg-violet-100 ring-1 ring-violet-300/50" />
                <span className="text-[var(--text-muted)]">Combined</span>
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="inline-block w-2.5 h-2.5 rounded-sm bg-teal-100 ring-1 ring-teal-300/50" />
                <span className="text-[var(--text-muted)]">Custom</span>
              </span>
            </div>
            <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-mid)]/30 p-4 space-y-1">
              <p className="text-xs font-medium text-[var(--text-muted)] mb-2">
                Original record will be updated with these values:
              </p>
              {Object.entries(mergedFields).map(([key, val]) => {
                const fi = fieldInfo.find((f) => f.key === key);
                const sel = fi
                  ? getSelection(fi.key, fi.pEmpty, fi.sEmpty)
                  : "primary";

                const rowColor =
                  sel === "custom"
                    ? "bg-teal-50 border-l-2 border-l-teal-400"
                    : sel === "both"
                      ? "bg-violet-50 border-l-2 border-l-violet-400"
                      : sel === "secondary"
                        ? "bg-orange-50 border-l-2 border-l-orange-400"
                        : "bg-[var(--brand)]/5 border-l-2 border-l-[var(--brand)]/40";

                const valueColor =
                  sel === "custom"
                    ? "text-teal-700"
                    : sel === "both"
                      ? "text-violet-700"
                      : sel === "secondary"
                        ? "text-orange-700"
                        : "text-[var(--text-main)]";

                return (
                  <div key={key} className={`flex gap-2 text-xs rounded px-2.5 py-1.5 ${rowColor}`}>
                    <span className="text-[var(--text-muted)] min-w-[150px] shrink-0 truncate">
                      {key}
                    </span>
                    <span className={`font-medium ${valueColor}`}>
                      {formatValue(val, linkedRecordNames)}
                    </span>
                  </div>
                );
              })}
            </div>
            <div className="flex justify-end">
              <button
                onClick={() => setConfirmState("merge")}
                disabled={mergeLoading || mergeSuccess}
                className="rounded-lg bg-red-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50 transition-colors"
              >
                {mergeLoading ? "Merging..." : "Merge & Delete New Record"}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Confirm Merge Modal */}
      <ConfirmModal
        isOpen={confirmState === "merge"}
        title="Confirm Merge"
        message={`This will update the original record (${resolvedPrimaryId.slice(0, 8)}...) with your selected field values and permanently delete the new record (${activeSecondaryId?.slice(0, 8)}...). This action cannot be undone.`}
        confirmLabel="Merge & Delete"
        isDestructive={true}
        onConfirm={handleMerge}
        onCancel={() => setConfirmState(null)}
      />

      {/* Confirm Dismiss Modal */}
      <ConfirmModal
        isOpen={confirmState === "dismiss"}
        title="Dismiss as Not a Duplicate"
        message="This will dismiss these records as duplicates. They will not be flagged again on future scans."
        confirmLabel="Dismiss"
        isDestructive={false}
        onConfirm={handleDismiss}
        onCancel={() => setConfirmState(null)}
      />
    </div>
  );
}
