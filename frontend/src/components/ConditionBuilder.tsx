import React, { useState, useRef, useEffect } from "react";
import { useFieldSearch, type FieldOption } from "../hooks/useFieldSearch";

// ----- Types -----

export interface Condition {
  type:
    | "exact_match"
    | "similarity"
    | "date_delta"
    | "set_overlap"
    | "value_equals";
  field?: string;
  field_id?: string;
  fields?: string[];
  field_ids?: string[];
  similarity?: number;
  tolerance_days?: number;
  overlap_ratio?: number;
  /** Required when type is value_equals — both records must equal this. */
  value?: string;
  description?: string;
  // AI metadata (display only)
  field_lookup_status?: string;
  field_lookup_message?: string;
  field_name_resolved?: string;
  field_names_resolved?: string[];
}

interface ConditionBuilderProps {
  conditions: Condition[];
  onChange: (conditions: Condition[]) => void;
  entity: string;
}

const CONDITION_TYPES = [
  { value: "exact_match", label: "Exact Match" },
  { value: "similarity", label: "Similarity" },
  { value: "date_delta", label: "Date Delta" },
  { value: "set_overlap", label: "Set Overlap" },
  { value: "value_equals", label: "Value Equals" },
];

const KNOWN_CONDITION_TYPES = CONDITION_TYPES.map((t) => t.value);

function fieldsArrayHasContent(fields: unknown): boolean {
  if (!Array.isArray(fields)) return false;
  return fields.some((f) => String(f ?? "").trim());
}

function coerceStringArray(val: unknown): string[] | undefined {
  if (val === undefined || val === null) return undefined;
  if (Array.isArray(val)) {
    return val.map((x) => (x === undefined || x === null ? "" : String(x)));
  }
  if (typeof val === "string" && val.trim()) {
    return [val.trim()];
  }
  return undefined;
}

/**
 * Ensure `field` / `fields` are populated when only Airtable IDs exist.
 * The scanner uses `field` / `fields`; IDs alone are not read.
 *
 * Similarity: backend allows a single `field` OR `fields[]`; the form only
 * edits `fields[]`, so we promote `field` / `field_id` into arrays.
 */
export function normalizeConditionsForForm(
  conditions: Condition[]
): Condition[] {
  return conditions.map((c) => {
    const copy = { ...c };
    const t = copy.type;

    if (
      t === "exact_match" ||
      t === "date_delta" ||
      t === "set_overlap" ||
      t === "value_equals"
    ) {
      if (!String(copy.field || "").trim() && copy.field_id) {
        copy.field = copy.field_id;
      }
    }

    if (t === "similarity") {
      const coercedFields = coerceStringArray(copy.fields);
      if (coercedFields) {
        copy.fields = coercedFields;
      }

      if (!String(copy.field || "").trim() && copy.field_id) {
        copy.field = copy.field_id;
      }

      const ids = [...(copy.field_ids || [])];
      if (ids.length > 0) {
        const fields = [...(copy.fields || [])];
        while (fields.length < ids.length) {
          fields.push("");
        }
        ids.forEach((id, i) => {
          if (id && !String(fields[i] || "").trim()) {
            fields[i] = id;
          }
        });
        copy.fields = fields;
      }

      const hasListContent = fieldsArrayHasContent(copy.fields);
      const single = String(copy.field || "").trim();

      if (!hasListContent && single) {
        copy.fields = [single];
        const fid = String(copy.field_id || "").trim();
        copy.field_ids = fid ? [fid] : [""];
        delete copy.field;
        delete copy.field_id;
      }

      if (Array.isArray(copy.fields) && copy.fields.length > 0) {
        const fids = [...(copy.field_ids || [])];
        while (fids.length < copy.fields.length) {
          fids.push("");
        }
        copy.field_ids = fids.slice(0, copy.fields.length);
      }
    }

    return copy;
  });
}

/** Strip AI metadata fields before saving to Firestore. */
export function cleanConditionsForSave(conditions: Condition[]): Condition[] {
  const normalized = normalizeConditionsForForm(conditions);
  return normalized.map((c) => {
    const {
      field_lookup_status,
      field_lookup_message,
      field_name_resolved,
      field_names_resolved,
      ...clean
    } = c;
    // Remove undefined/null keys
    return Object.fromEntries(
      Object.entries(clean).filter(([, v]) => v !== undefined && v !== null)
    ) as Condition;
  });
}

// ----- FieldAutocomplete -----

function FieldAutocomplete({
  value,
  fieldId,
  entity,
  onSelect,
  onChange,
  placeholder,
}: {
  value: string;
  fieldId?: string;
  entity: string;
  onSelect: (name: string, id: string) => void;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const { searchTerm, setSearchTerm, fieldOptions, loading } =
    useFieldSearch(entity);
  const [showDropdown, setShowDropdown] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div className="relative" ref={wrapperRef}>
      <input
        type="text"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setSearchTerm(e.target.value);
          setShowDropdown(true);
        }}
        onFocus={() => {
          if (fieldOptions.length > 0) setShowDropdown(true);
        }}
        placeholder={placeholder || "Search for a field..."}
        className="w-full p-2 border border-[var(--border)] rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[var(--cta-blue)]"
      />
      {fieldId && (
        <div className="flex items-center gap-1 mt-1">
          <span className="text-green-600 text-xs">&#10003;</span>
          <span className="text-xs font-mono text-[var(--text-muted)]">
            {fieldId}
          </span>
        </div>
      )}
      {!fieldId && value && (
        <div className="flex items-center gap-1 mt-1">
          <span className="text-yellow-600 text-xs">&#9888;</span>
          <span className="text-xs text-[var(--text-muted)]">
            No Airtable field ID yet — type at least 2 characters to search the
            table schema, then pick a row to attach the stable{" "}
            <span className="font-mono">fld…</span> ID
          </span>
        </div>
      )}
      {loading && (
        <div className="absolute right-2 top-2 text-gray-400 text-xs">
          Searching...
        </div>
      )}
      {showDropdown && fieldOptions.length > 0 && (
        <div className="absolute z-20 w-full mt-1 bg-white border border-[var(--border)] rounded-lg shadow-lg max-h-48 overflow-y-auto">
          {fieldOptions.map((opt: FieldOption) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => {
                onSelect(opt.name, opt.id);
                setShowDropdown(false);
                setSearchTerm("");
              }}
              className="w-full text-left px-3 py-2 hover:bg-gray-100 border-b border-[var(--border)] last:border-b-0"
            >
              <div className="text-sm font-medium">{opt.name}</div>
              <div className="text-xs text-gray-500">
                {opt.id}
                {opt.type && <span className="ml-2 text-gray-400">{opt.type}</span>}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ----- ConditionRow -----

function ConditionRow({
  condition,
  index,
  entity,
  onUpdate,
  onRemove,
}: {
  condition: Condition;
  index: number;
  entity: string;
  onUpdate: (index: number, updated: Condition) => void;
  onRemove: (index: number) => void;
}) {
  const updateField = (key: string, value: any) => {
    onUpdate(index, { ...condition, [key]: value });
  };

  const handleTypeChange = (newType: string) => {
    const prev = condition;
    const singleField = prev.field || prev.fields?.[0];
    const singleFieldId = prev.field_id || prev.field_ids?.[0];
    const base: Condition = {
      type: newType as Condition["type"],
      description: prev.description,
    };

    if (newType === "similarity") {
      base.similarity = prev.similarity ?? 0.8;
      if (prev.fields?.length) {
        base.fields = [...prev.fields];
        base.field_ids = [...(prev.field_ids || [])];
      } else if (singleField) {
        base.fields = [singleField];
        base.field_ids = singleFieldId ? [singleFieldId] : [""];
      } else {
        base.fields = [""];
        base.field_ids = [""];
      }
    } else if (newType === "date_delta") {
      base.field = singleField;
      base.field_id = singleFieldId;
      base.tolerance_days = prev.tolerance_days ?? 1;
    } else if (newType === "set_overlap") {
      base.field = singleField;
      base.field_id = singleFieldId;
      base.overlap_ratio = prev.overlap_ratio ?? 0.5;
    } else if (newType === "value_equals") {
      base.field = singleField;
      base.field_id = singleFieldId;
      base.value = prev.value ?? "";
    } else {
      base.field = singleField;
      base.field_id = singleFieldId;
    }
    onUpdate(index, base);
  };

  // For similarity type with multi-field support
  const handleMultiFieldSelect = (
    fieldIndex: number,
    name: string,
    id: string
  ) => {
    const newFields = [...(condition.fields || [])];
    const newFieldIds = [...(condition.field_ids || [])];
    newFields[fieldIndex] = name;
    newFieldIds[fieldIndex] = id;
    onUpdate(index, { ...condition, fields: newFields, field_ids: newFieldIds });
  };

  const handleMultiFieldChange = (fieldIndex: number, value: string) => {
    const newFields = [...(condition.fields || [])];
    newFields[fieldIndex] = value;
    // Clear field_id when user types manually
    const newFieldIds = [...(condition.field_ids || [])];
    newFieldIds[fieldIndex] = "";
    onUpdate(index, { ...condition, fields: newFields, field_ids: newFieldIds });
  };

  const addField = () => {
    const newFields = [...(condition.fields || []), ""];
    const newFieldIds = [...(condition.field_ids || []), ""];
    onUpdate(index, { ...condition, fields: newFields, field_ids: newFieldIds });
  };

  const removeField = (fieldIndex: number) => {
    const newFields = (condition.fields || []).filter(
      (_, i) => i !== fieldIndex
    );
    const newFieldIds = (condition.field_ids || []).filter(
      (_, i) => i !== fieldIndex
    );
    onUpdate(index, { ...condition, fields: newFields, field_ids: newFieldIds });
  };

  const typeSelectValue = KNOWN_CONDITION_TYPES.includes(condition.type)
    ? condition.type
    : "exact_match";
  const hasUnsupportedType = !KNOWN_CONDITION_TYPES.includes(condition.type);

  return (
    <div className="border border-[var(--border)] rounded-lg p-4 bg-white">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">
          Condition {index + 1}
        </span>
        <button
          type="button"
          onClick={() => onRemove(index)}
          className="text-gray-400 hover:text-red-500 text-lg leading-none"
          title="Remove condition"
        >
          &times;
        </button>
      </div>

      {/* Type selector */}
      <div className="mb-3">
        <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
          Match Type
        </label>
        <select
          value={typeSelectValue}
          onChange={(e) => handleTypeChange(e.target.value)}
          className="w-full p-2 border border-[var(--border)] rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[var(--cta-blue)]"
        >
          {CONDITION_TYPES.map((ct) => (
            <option key={ct.value} value={ct.value}>
              {ct.label}
            </option>
          ))}
        </select>
        {hasUnsupportedType && (
          <p className="text-xs text-amber-700 mt-1">
            Stored type{" "}
            <span className="font-mono">{String(condition.type)}</span> is not
            supported in the form. Choose a type above to replace it, or edit in
            Raw JSON.
          </p>
        )}
      </div>

      {/* Type-specific fields */}
      {condition.type === "exact_match" && (
        <div>
          <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
            Field
          </label>
          <FieldAutocomplete
            value={condition.field || ""}
            fieldId={condition.field_id}
            entity={entity}
            onSelect={(name, id) =>
              onUpdate(index, { ...condition, field: name, field_id: id })
            }
            onChange={(val) => {
              onUpdate(index, { ...condition, field: val, field_id: undefined });
            }}
          />
        </div>
      )}

      {condition.type === "similarity" && (
        <>
          <div className="mb-3">
            <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
              Fields
            </label>
            <div className="space-y-2">
              {(condition.fields || [""]).map((fieldVal, fi) => (
                <div key={fi} className="flex items-start gap-2">
                  <div className="flex-1">
                    <FieldAutocomplete
                      value={fieldVal}
                      fieldId={condition.field_ids?.[fi]}
                      entity={entity}
                      onSelect={(name, id) =>
                        handleMultiFieldSelect(fi, name, id)
                      }
                      onChange={(val) => handleMultiFieldChange(fi, val)}
                      placeholder={`Field ${fi + 1}`}
                    />
                  </div>
                  {(condition.fields?.length || 0) > 1 && (
                    <button
                      type="button"
                      onClick={() => removeField(fi)}
                      className="mt-2 text-gray-400 hover:text-red-500 text-sm"
                      title="Remove field"
                    >
                      &times;
                    </button>
                  )}
                </div>
              ))}
            </div>
            {(condition.fields?.length || 0) < 4 && (
              <button
                type="button"
                onClick={addField}
                className="mt-2 text-xs text-[var(--cta-blue)] hover:underline"
              >
                + Add field
              </button>
            )}
          </div>
          <div>
            <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
              Threshold
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                max={100}
                step={1}
                value={Math.round((condition.similarity ?? 0.8) * 100)}
                onChange={(e) =>
                  updateField(
                    "similarity",
                    Math.min(1, Math.max(0, Number(e.target.value) / 100))
                  )
                }
                className="w-20 p-2 border border-[var(--border)] rounded-lg text-sm text-center"
              />
              <span className="text-sm text-[var(--text-muted)]">%</span>
            </div>
          </div>
        </>
      )}

      {condition.type === "date_delta" && (
        <>
          <div className="mb-3">
            <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
              Field
            </label>
            <FieldAutocomplete
              value={condition.field || ""}
              fieldId={condition.field_id}
              entity={entity}
              onSelect={(name, id) =>
                onUpdate(index, { ...condition, field: name, field_id: id })
              }
              onChange={(val) => {
                onUpdate(index, {
                  ...condition,
                  field: val,
                  field_id: undefined,
                });
              }}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
              Tolerance
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                max={365}
                value={condition.tolerance_days ?? 1}
                onChange={(e) =>
                  updateField("tolerance_days", Number(e.target.value))
                }
                className="w-20 p-2 border border-[var(--border)] rounded-lg text-sm text-center"
              />
              <span className="text-sm text-[var(--text-muted)]">days</span>
            </div>
          </div>
        </>
      )}

      {condition.type === "set_overlap" && (
        <>
          <div className="mb-3">
            <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
              Field
            </label>
            <FieldAutocomplete
              value={condition.field || ""}
              fieldId={condition.field_id}
              entity={entity}
              onSelect={(name, id) =>
                onUpdate(index, { ...condition, field: name, field_id: id })
              }
              onChange={(val) => {
                onUpdate(index, {
                  ...condition,
                  field: val,
                  field_id: undefined,
                });
              }}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
              Overlap Ratio
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                max={100}
                step={1}
                value={Math.round((condition.overlap_ratio ?? 0.5) * 100)}
                onChange={(e) =>
                  updateField(
                    "overlap_ratio",
                    Math.min(1, Math.max(0, Number(e.target.value) / 100))
                  )
                }
                className="w-20 p-2 border border-[var(--border)] rounded-lg text-sm text-center"
              />
              <span className="text-sm text-[var(--text-muted)]">%</span>
            </div>
          </div>
        </>
      )}

      {condition.type === "value_equals" && (
        <>
          <div className="mb-3">
            <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
              Field
            </label>
            <FieldAutocomplete
              value={condition.field || ""}
              fieldId={condition.field_id}
              entity={entity}
              onSelect={(name, id) =>
                onUpdate(index, { ...condition, field: name, field_id: id })
              }
              onChange={(val) => {
                onUpdate(index, {
                  ...condition,
                  field: val,
                  field_id: undefined,
                });
              }}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
              Expected value (both records must match)
            </label>
            <input
              type="text"
              value={condition.value ?? ""}
              onChange={(e) => updateField("value", e.target.value)}
              placeholder="e.g., Unsure"
              className="w-full p-2 border border-[var(--border)] rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[var(--cta-blue)]"
            />
          </div>
        </>
      )}
    </div>
  );
}

// ----- ConditionBuilder -----

export function ConditionBuilder({
  conditions,
  onChange,
  entity,
}: ConditionBuilderProps) {
  const handleUpdate = (index: number, updated: Condition) => {
    const next = [...conditions];
    next[index] = updated;
    onChange(next);
  };

  const handleRemove = (index: number) => {
    onChange(conditions.filter((_, i) => i !== index));
  };

  const handleAdd = () => {
    onChange([...conditions, { type: "exact_match", field: "" }]);
  };

  return (
    <div>
      <label className="block text-sm font-medium text-[var(--text-main)] mb-2">
        Conditions
      </label>
      {conditions.length === 0 && (
        <p className="text-sm text-[var(--text-muted)] mb-2">
          No conditions yet. Add one below.
        </p>
      )}
      <div className="space-y-3 mb-3">
        {conditions.map((condition, i) => (
          <ConditionRow
            key={i}
            condition={condition}
            index={i}
            entity={entity}
            onUpdate={handleUpdate}
            onRemove={handleRemove}
          />
        ))}
      </div>
      <button
        type="button"
        onClick={handleAdd}
        className="w-full py-2 border-2 border-dashed border-[var(--border)] rounded-lg text-sm text-[var(--text-muted)] hover:border-[var(--cta-blue)] hover:text-[var(--cta-blue)] transition-colors"
      >
        + Add Condition
      </button>
    </div>
  );
}
