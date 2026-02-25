import React, { useState, useRef, useEffect } from "react";
import { useFieldSearch, type FieldOption } from "../hooks/useFieldSearch";

// ----- Types -----

export interface Condition {
  type: "exact_match" | "similarity" | "date_delta" | "set_overlap";
  field?: string;
  field_id?: string;
  fields?: string[];
  field_ids?: string[];
  similarity?: number;
  tolerance_days?: number;
  overlap_ratio?: number;
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
];

/** Strip AI metadata fields before saving to Firestore. */
export function cleanConditionsForSave(conditions: Condition[]): Condition[] {
  return conditions.map((c) => {
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
            No field ID — select from dropdown to resolve
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
    // Reset type-specific fields when changing type
    const base: Condition = {
      type: newType as Condition["type"],
      field: condition.field,
      field_id: condition.field_id,
    };
    if (newType === "similarity") {
      base.similarity = condition.similarity ?? 0.8;
      // Convert single field to fields array if needed
      if (condition.field && !condition.fields) {
        base.fields = [condition.field];
        base.field_ids = condition.field_id ? [condition.field_id] : [];
        delete base.field;
        delete base.field_id;
      } else if (condition.fields) {
        base.fields = condition.fields;
        base.field_ids = condition.field_ids;
      }
    } else if (newType === "date_delta") {
      base.tolerance_days = condition.tolerance_days ?? 1;
    } else if (newType === "set_overlap") {
      base.overlap_ratio = condition.overlap_ratio ?? 0.5;
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
          value={condition.type}
          onChange={(e) => handleTypeChange(e.target.value)}
          className="w-full p-2 border border-[var(--border)] rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[var(--cta-blue)]"
        >
          {CONDITION_TYPES.map((ct) => (
            <option key={ct.value} value={ct.value}>
              {ct.label}
            </option>
          ))}
        </select>
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
