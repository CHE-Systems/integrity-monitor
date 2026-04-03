import React, { useState, useEffect } from "react";
import { useAuth } from "../hooks/useAuth";
import { API_BASE } from "../config/api";
import { ACTIVE_ENTITIES, ENTITY_TABLE_MAPPING } from "../config/entities";
import {
  ConditionBuilder,
  cleanConditionsForSave,
  normalizeConditionsForForm,
  type Condition,
} from "./ConditionBuilder";
import {
  isProbablyAirtableFieldId,
  normalizeRequiredFieldRuleShape,
} from "../utils/airtableFieldIds";

interface RuleEditorProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (
    ruleData: Record<string, any>,
    category: string,
    entity: string | null
  ) => void;
  category?: string;
  entity?: string;
  initialRule?: Record<string, any>;
  mode: "create" | "edit";
  currentEntity?: string; // Current table being viewed
}

// Generate entity options from central config
const ENTITY_OPTIONS = ACTIVE_ENTITIES.map((entity) => ({
  value: entity,
  label: ENTITY_TABLE_MAPPING[entity] || entity,
}));

const ALL_CATEGORY_OPTIONS = [
  { value: "duplicates", label: "Duplicate Detection" },
  { value: "relationships", label: "Relationship" },
  { value: "required_fields", label: "Required Field" },
  { value: "value_checks", label: "Value Check" },
  { value: "attendance_rules", label: "Attendance Rule" },
];

export function RuleEditor({
  isOpen,
  onClose,
  onSave,
  category: initialCategory,
  entity: initialEntity,
  initialRule,
  mode,
  currentEntity,
}: RuleEditorProps) {
  const { getToken } = useAuth();
  const [ruleData, setRuleData] = useState<Record<string, any>>(
    initialRule || {}
  );
  const [selectedCategory, setSelectedCategory] = useState<string>(
    initialCategory || "duplicates"
  );
  const [selectedEntity, setSelectedEntity] = useState<string>(
    initialEntity || currentEntity || "students"
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [conditionsJson, setConditionsJson] = useState<string>("");
  const [thresholdsJson, setThresholdsJson] = useState<string>("");
  const [editMode, setEditMode] = useState<"form" | "json">("form");
  const [rawJson, setRawJson] = useState<string>("");

  // Field lookup states (for required fields)
  const [fieldSearchTerm, setFieldSearchTerm] = useState("");
  const [fieldOptions, setFieldOptions] = useState<
    Array<{ id: string; name: string }>
  >([]);
  const [fieldLookupLoading, setFieldLookupLoading] = useState(false);

  // Filter category options based on entity - attendance_rules only for attendance table
  const categoryOptions = React.useMemo(() => {
    const entity = selectedEntity || currentEntity || "students";
    if (entity === "attendance") {
      return ALL_CATEGORY_OPTIONS;
    }
    return ALL_CATEGORY_OPTIONS.filter(
      (option) => option.value !== "attendance_rules"
    );
  }, [selectedEntity, currentEntity]);

  useEffect(() => {
    let category = initialCategory || "duplicates";
    let dataForFieldTerm: Record<string, any> | null = null;

    if (initialRule) {
      let data: Record<string, any> = { ...initialRule };
      if (
        category === "duplicates" &&
        Array.isArray(data.conditions) &&
        data.conditions.length > 0
      ) {
        data = {
          ...data,
          conditions: normalizeConditionsForForm(
            data.conditions as Condition[]
          ),
        };
      }
      if (
        category === "required_fields" ||
        category === "value_checks"
      ) {
        data = normalizeRequiredFieldRuleShape(data) as Record<string, any>;
      }
      dataForFieldTerm = data;
      setRuleData(data);
      setConditionsJson(
        data.conditions ? JSON.stringify(data.conditions, null, 2) : ""
      );
      setThresholdsJson(
        initialRule.thresholds
          ? JSON.stringify(initialRule.thresholds, null, 2)
          : ""
      );
      setRawJson(JSON.stringify(data, null, 2));
    } else {
      setRuleData({});
      setConditionsJson("");
      setThresholdsJson("");
      setRawJson("{}");
    }
    const entity = initialEntity || currentEntity || "students";
    setSelectedEntity(entity);

    // If attendance_rules is selected but entity is not attendance, reset to duplicates
    if (category === "attendance_rules" && entity !== "attendance") {
      category = "duplicates";
    }
    setSelectedCategory(category);
    setErrors({});
    setEditMode("form"); // Reset to form mode when opening

    if (category === "value_checks" && dataForFieldTerm?.field) {
      setFieldSearchTerm(String(dataForFieldTerm.field));
    } else {
      setFieldSearchTerm("");
    }
  }, [initialRule, initialCategory, initialEntity, currentEntity, isOpen]);

  // Lookup fields when search term changes (for required fields)
  useEffect(() => {
    if (!selectedEntity || !fieldSearchTerm || fieldSearchTerm.length < 2) {
      setFieldOptions([]);
      return;
    }

    const lookupFields = async () => {
      setFieldLookupLoading(true);
      try {
        const token = await getToken();
        if (!token) {
          console.error("Not authenticated");
          return;
        }
        const response = await fetch(
          `${API_BASE}/airtable/schema/fields/${selectedEntity}?search=${encodeURIComponent(
            fieldSearchTerm
          )}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }
        );
        if (response.ok) {
          const data = await response.json();
          setFieldOptions(data.fields || []);
        }
      } catch (error) {
        console.error("Failed to lookup fields:", error);
      } finally {
        setFieldLookupLoading(false);
      }
    };

    const debounceTimer = setTimeout(lookupFields, 300);
    return () => clearTimeout(debounceTimer);
  }, [selectedEntity, fieldSearchTerm, getToken]);

  /** Resolve fld… stored in `field` into display name + `field_id` using schema snapshot. */
  useEffect(() => {
    if (!isOpen) return;
    if (
      selectedCategory !== "required_fields" &&
      selectedCategory !== "value_checks"
    ) {
      return;
    }

    const f = String(ruleData.field ?? "").trim();
    const fid = String(ruleData.field_id ?? "").trim();
    const needsResolution =
      isProbablyAirtableFieldId(f) ||
      (f === "" && isProbablyAirtableFieldId(fid));
    if (!needsResolution) return;

    const id = isProbablyAirtableFieldId(fid)
      ? fid
      : isProbablyAirtableFieldId(f)
        ? f
        : "";
    if (!id) return;

    const entityForSchema =
      selectedCategory === "value_checks" && ruleData.source_entity
        ? String(ruleData.source_entity)
        : selectedEntity;
    if (!entityForSchema) return;

    let cancelled = false;

    (async () => {
      try {
        const token = await getToken();
        if (!token || cancelled) return;
        const res = await fetch(
          `${API_BASE}/airtable/schema/fields/${encodeURIComponent(
            entityForSchema
          )}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!res.ok || cancelled) return;
        const payload = await res.json();
        const match = (payload.fields || []).find(
          (row: { id?: string }) => row.id === id
        );
        if (!match || cancelled) return;

        setRuleData((prev) => {
          const pf = String(prev.field ?? "").trim();
          const pfid = String(prev.field_id ?? "").trim();
          const stillNeeds =
            isProbablyAirtableFieldId(pf) ||
            (pf === "" && isProbablyAirtableFieldId(pfid));
          if (!stillNeeds) return prev;
          const prevTarget = isProbablyAirtableFieldId(pfid)
            ? pfid
            : isProbablyAirtableFieldId(pf)
              ? pf
              : "";
          if (prevTarget !== id) return prev;

          const next: Record<string, any> = {
            ...prev,
            field: match.name,
            field_id: match.id,
          };
          const fn = String(prev.field_name ?? "").trim();
          if (
            !fn ||
            isProbablyAirtableFieldId(fn) ||
            fn === pf ||
            fn === id
          ) {
            next.field_name = match.name;
          }
          return next;
        });

        if (selectedCategory === "value_checks") {
          setFieldSearchTerm(match.name);
        }
      } catch {
        /* schema missing or network */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    isOpen,
    selectedCategory,
    selectedEntity,
    ruleData.field,
    ruleData.field_id,
    ruleData.source_entity,
    getToken,
  ]);

  if (!isOpen) return null;

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {};

    // JSON mode validation
    if (editMode === "json") {
      try {
        const parsed = JSON.parse(rawJson);
        // Basic validation - ensure it's an object
        if (typeof parsed !== "object" || parsed === null) {
          newErrors.rawJson = "Rule must be a JSON object";
        }
      } catch {
        newErrors.rawJson = "Invalid JSON format";
      }
      setErrors(newErrors);
      return Object.keys(newErrors).length === 0;
    }

    // Form mode validation
    if (selectedCategory === "duplicates") {
      if (!ruleData.description)
        newErrors.description = "Description is required";
      if (!ruleData.rule_id && mode === "create")
        newErrors.rule_id = "Rule ID is required";
      const conditions = ruleData.conditions as Condition[] | undefined;
      if (!conditions || conditions.length === 0) {
        newErrors.conditions = "At least one condition is required";
      } else {
        for (const cond of conditions) {
          if (!cond.type) {
            newErrors.conditions = "Each condition must have a match type";
            break;
          }
          if (!cond.field && (!cond.fields || cond.fields.length === 0)) {
            newErrors.conditions = "Each condition must have at least one field";
            break;
          }
          if (cond.type === "value_equals") {
            const v = cond.value;
            if (v === undefined || v === null || String(v).trim() === "") {
              newErrors.conditions =
                "Value Equals conditions need an expected value";
              break;
            }
          }
        }
      }
    } else if (selectedCategory === "relationships") {
      if (!ruleData.target) newErrors.target = "Target entity is required";
      if (!ruleData.message) newErrors.message = "Message is required";
    } else if (selectedCategory === "required_fields") {
      if (!ruleData.field) newErrors.field = "Field name is required";
      if (!ruleData.message) newErrors.message = "Message is required";
    } else if (selectedCategory === "attendance_rules") {
      if (thresholdsJson.trim() === "") {
        newErrors.thresholds = "Thresholds JSON is required";
      } else {
        try {
          JSON.parse(thresholdsJson);
        } catch {
          newErrors.thresholdsJson = "Invalid JSON format";
        }
      }
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSave = () => {
    if (!validate()) {
      return;
    }

    // JSON mode - parse and save directly
    if (editMode === "json") {
      try {
        const parsed = JSON.parse(rawJson);
        onSave(parsed, selectedCategory, selectedEntity);
        handleClose();
        return;
      } catch {
        // Validation should have caught this
        return;
      }
    }

    // Form mode - clean conditions before saving
    if (selectedCategory === "duplicates" && ruleData.conditions) {
      ruleData.conditions = cleanConditionsForSave(ruleData.conditions as Condition[]);
    }
    if (
      selectedCategory === "attendance_rules" &&
      thresholdsJson.trim() !== ""
    ) {
      try {
        const parsed = JSON.parse(thresholdsJson);
        updateField("thresholds", parsed);
      } catch {
        // Validation should have caught this, but just in case
        return;
      }
    }

    onSave(ruleData, selectedCategory, selectedEntity);
    handleClose();
  };

  const handleClose = () => {
    setRuleData({});
    setErrors({});
    onClose();
  };

  const updateField = (field: string, value: any) => {
    setRuleData((prev) => ({ ...prev, [field]: value }));
    if (errors[field]) {
      setErrors((prev) => {
        const newErrors = { ...prev };
        delete newErrors[field];
        return newErrors;
      });
    }
  };

  const renderDuplicateFields = () => (
    <>
      <div>
        <label className="block text-sm font-medium text-[var(--text-main)] mb-2">
          Rule ID {mode === "create" && "*"}
        </label>
        <input
          type="text"
          value={ruleData.rule_id || ""}
          onChange={(e) => updateField("rule_id", e.target.value)}
          disabled={mode === "edit"}
          placeholder="e.g., dup.student.email_match"
          className={`w-full p-2 border rounded-lg ${
            errors.rule_id ? "border-red-500" : "border-[var(--border)]"
          } ${mode === "edit" ? "bg-gray-100" : ""}`}
        />
        {errors.rule_id && (
          <p className="text-red-500 text-xs mt-1">{errors.rule_id}</p>
        )}
      </div>
      <div>
        <label className="block text-sm font-medium text-[var(--text-main)] mb-2">
          Description *
        </label>
        <textarea
          value={ruleData.description || ""}
          onChange={(e) => updateField("description", e.target.value)}
          placeholder="Describe what this rule detects"
          className={`w-full p-2 border rounded-lg ${
            errors.description ? "border-red-500" : "border-[var(--border)]"
          }`}
          rows={3}
        />
        {errors.description && (
          <p className="text-red-500 text-xs mt-1">{errors.description}</p>
        )}
      </div>
      <div>
        <label className="block text-sm font-medium text-[var(--text-main)] mb-2">
          Severity
        </label>
        <select
          value={ruleData.severity || "warning"}
          onChange={(e) => updateField("severity", e.target.value)}
          className="w-full p-2 border border-[var(--border)] rounded-lg"
        >
          <option value="warning">Warning</option>
          <option value="info">Info</option>
          <option value="critical">Critical</option>
        </select>
      </div>
      <ConditionBuilder
        conditions={(ruleData.conditions as Condition[]) || []}
        onChange={(conditions) => {
          updateField("conditions", conditions);
          setConditionsJson(JSON.stringify(conditions, null, 2));
        }}
        entity={selectedEntity}
      />
      {errors.conditions && (
        <p className="text-red-500 text-xs mt-1">{errors.conditions}</p>
      )}
    </>
  );

  const renderRelationshipFields = () => (
    <>
      <div>
        <label className="block text-sm font-medium text-[var(--text-main)] mb-2">
          Target Entity *
        </label>
        <select
          value={ruleData.target || ""}
          onChange={(e) => updateField("target", e.target.value)}
          className={`w-full p-2 border rounded-lg ${
            errors.target ? "border-red-500" : "border-[var(--border)]"
          }`}
        >
          <option value="">Select target table...</option>
          {ENTITY_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {errors.target && (
          <p className="text-red-500 text-xs mt-1">{errors.target}</p>
        )}
      </div>
      <div>
        <label className="block text-sm font-medium text-[var(--text-main)] mb-2">
          Message *
        </label>
        <textarea
          value={ruleData.message || ""}
          onChange={(e) => updateField("message", e.target.value)}
          placeholder="Error message when rule is violated"
          className={`w-full p-2 border rounded-lg ${
            errors.message ? "border-red-500" : "border-[var(--border)]"
          }`}
          rows={2}
        />
        {errors.message && (
          <p className="text-red-500 text-xs mt-1">{errors.message}</p>
        )}
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-[var(--text-main)] mb-2">
            Min Links
          </label>
          <input
            type="number"
            value={ruleData.min_links || 0}
            onChange={(e) =>
              updateField("min_links", parseInt(e.target.value) || 0)
            }
            className="w-full p-2 border border-[var(--border)] rounded-lg"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-[var(--text-main)] mb-2">
            Max Links (optional)
          </label>
          <input
            type="number"
            value={ruleData.max_links || ""}
            onChange={(e) =>
              updateField(
                "max_links",
                e.target.value ? parseInt(e.target.value) : null
              )
            }
            className="w-full p-2 border border-[var(--border)] rounded-lg"
            placeholder="Unlimited"
          />
        </div>
      </div>
      <div>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={ruleData.require_active || false}
            onChange={(e) => updateField("require_active", e.target.checked)}
            className="w-4 h-4"
          />
          <span className="text-sm font-medium text-[var(--text-main)]">
            Require Active Links Only
          </span>
        </label>
      </div>
    </>
  );

  const handleFieldSelect = (fieldId: string, fieldName: string) => {
    const prevName = String(ruleData.field_name ?? "").trim();
    const prevField = String(ruleData.field ?? "").trim();
    updateField("field", fieldName);
    updateField("field_id", fieldId);
    if (
      !prevName ||
      isProbablyAirtableFieldId(prevName) ||
      prevName === prevField ||
      prevName === fieldId
    ) {
      updateField("field_name", fieldName);
    }
    setFieldSearchTerm("");
    setFieldOptions([]);
  };

  const renderRequiredFieldFields = () => (
      <>
        <div>
          <label className="block text-sm font-medium text-[var(--text-main)] mb-2">
            Field Name *
          </label>
          <div className="relative">
            <input
              type="text"
              value={ruleData.field || ""}
              onChange={(e) => {
                updateField("field", e.target.value);
                setFieldSearchTerm(e.target.value);
              }}
              placeholder="e.g., email, phone, emergency_contact"
              className={`w-full p-2 border rounded-lg ${
                errors.field ? "border-red-500" : "border-[var(--border)]"
              }`}
            />
            {fieldOptions.length > 0 && (
              <div className="absolute z-10 w-full mt-1 bg-white border border-[var(--border)] rounded-lg shadow-lg max-h-60 overflow-y-auto">
                {fieldOptions.map((field) => (
                  <button
                    key={field.id}
                    type="button"
                    onClick={() => handleFieldSelect(field.id, field.name)}
                    className="w-full text-left px-4 py-2 hover:bg-gray-100 border-b border-[var(--border)] last:border-b-0"
                  >
                    <div className="font-medium">{field.name}</div>
                    <div className="text-xs text-gray-500">{field.id}</div>
                  </button>
                ))}
              </div>
            )}
            {fieldLookupLoading && (
              <div className="absolute right-2 top-2 text-gray-400 text-sm">
                Searching...
              </div>
            )}
          </div>
          {errors.field && (
            <p className="text-red-500 text-xs mt-1">{errors.field}</p>
          )}
          <p className="text-xs text-[var(--text-muted)] mt-1">
            Start typing to search for fields. Select a field to auto-fill the
            Field ID.
          </p>
        </div>
        <div>
          <label className="block text-sm font-medium text-[var(--text-main)] mb-2">
            Field ID (optional, recommended)
          </label>
          <input
            type="text"
            value={ruleData.field_id || ""}
            onChange={(e) => updateField("field_id", e.target.value)}
            placeholder="e.g., fldUXiLJmTxJ9aeRp"
            className="w-full p-2 border border-[var(--border)] rounded-lg font-mono text-sm"
          />
          <p className="text-xs text-[var(--text-muted)] mt-1">
            Airtable field ID (starts with "fld"). More reliable than field
            name. Auto-filled when selecting a field above.
          </p>
        </div>
        <div>
          <label className="block text-sm font-medium text-[var(--text-main)] mb-2">
            Rule Label Name (for display)
          </label>
          <input
            type="text"
            value={ruleData.field_name || ruleData.field || ""}
            onChange={(e) => updateField("field_name", e.target.value)}
            placeholder="e.g., Background Check, Certification, etc."
            className="w-full p-2 border border-[var(--border)] rounded-lg"
          />
          <p className="text-xs text-[var(--text-muted)] mt-1">
            Customizable name for the rule label. This will appear in the rule
            list. Auto-filled from field name when selecting a field.
          </p>
        </div>
        <div>
          <label className="block text-sm font-medium text-[var(--text-main)] mb-2">
            Message *
          </label>
          <textarea
            value={ruleData.message || ""}
            onChange={(e) => updateField("message", e.target.value)}
            placeholder="Error message when field is missing"
            className={`w-full p-2 border rounded-lg ${
              errors.message ? "border-red-500" : "border-[var(--border)]"
            }`}
            rows={2}
          />
          {errors.message && (
            <p className="text-red-500 text-xs mt-1">{errors.message}</p>
          )}
        </div>
        <div>
          <label className="block text-sm font-medium text-[var(--text-main)] mb-2">
            Severity
          </label>
          <select
            value={ruleData.severity || "warning"}
            onChange={(e) => updateField("severity", e.target.value)}
            className="w-full p-2 border border-[var(--border)] rounded-lg"
          >
            <option value="info">Info</option>
            <option value="warning">Warning</option>
            <option value="critical">Critical</option>
          </select>
        </div>
      </>
  );

  const renderAttendanceFields = () => (
    <div>
      <label className="block text-sm font-medium text-[var(--text-main)] mb-2">
        Thresholds (JSON)
      </label>
      <textarea
        value={thresholdsJson}
        onChange={(e) => {
          const value = e.target.value;
          setThresholdsJson(value);
          // Try to parse and update ruleData if valid JSON
          if (value.trim() === "") {
            updateField("thresholds", {});
          } else {
            try {
              const parsed = JSON.parse(value);
              updateField("thresholds", parsed);
              // Clear JSON error if it exists
              if (errors.thresholdsJson) {
                setErrors((prev) => {
                  const newErrors = { ...prev };
                  delete newErrors.thresholdsJson;
                  return newErrors;
                });
              }
            } catch {
              // Invalid JSON - allow user to continue editing
            }
          }
        }}
        className={`w-full p-2 border rounded-lg font-mono text-sm ${
          errors.thresholds || errors.thresholdsJson
            ? "border-red-500"
            : "border-[var(--border)]"
        }`}
        rows={8}
      />
      {errors.thresholds && (
        <p className="text-red-500 text-xs mt-1">{errors.thresholds}</p>
      )}
      {errors.thresholdsJson && (
        <p className="text-red-500 text-xs mt-1">{errors.thresholdsJson}</p>
      )}
    </div>
  );

  const renderValueCheckFields = () => (
    <>
      <div>
        <label className="block text-sm font-medium text-[var(--text-main)] mb-2">
          Source Entity (Entity to Check)
        </label>
        <select
          value={ruleData.source_entity || ""}
          onChange={(e) => updateField("source_entity", e.target.value || undefined)}
          className="w-full p-2 border border-[var(--border)] rounded-lg"
        >
          <option value="">Same as rule entity (default)</option>
          {ENTITY_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <p className="text-xs text-[var(--text-muted)] mt-1">
          The entity/table to check records from. If empty, checks the same entity where the rule is stored.
        </p>
      </div>
      <div className="relative">
        <label className="block text-sm font-medium text-[var(--text-main)] mb-2">
          Field Name or ID *
        </label>
        <input
          type="text"
          value={fieldSearchTerm || ruleData.field || ""}
          onChange={(e) => {
            const value = e.target.value;
            setFieldSearchTerm(value);
            updateField("field", value);
            if (value.length >= 2) {
              lookupFields(value);
            } else {
              setFieldOptions([]);
            }
          }}
          placeholder="Start typing field name or ID..."
          className={`w-full p-2 border rounded-lg ${
            errors.field ? "border-red-500" : "border-[var(--border)]"
          }`}
        />
        {fieldOptions.length > 0 && (
          <div className="absolute z-10 w-full mt-1 bg-white border border-[var(--border)] rounded-lg shadow-lg max-h-60 overflow-y-auto">
            {fieldOptions.map((field) => (
              <button
                key={field.id}
                type="button"
                onClick={() => {
                  setFieldSearchTerm(field.name);
                  updateField("field", field.name);
                  updateField("field_id", field.id);
                  setFieldOptions([]);
                }}
                className="w-full text-left p-2 hover:bg-gray-100 border-b border-[var(--border)] last:border-b-0"
              >
                <div className="font-medium">{field.name}</div>
                <div className="text-xs text-gray-500">{field.id}</div>
              </button>
            ))}
          </div>
        )}
        {fieldLookupLoading && (
          <div className="absolute right-2 top-2 text-gray-400 text-sm">
            Searching...
          </div>
        )}
      </div>
      {errors.field && (
        <p className="text-red-500 text-xs mt-1">{errors.field}</p>
      )}
      <p className="text-xs text-[var(--text-muted)] mt-1">
        Start typing to search for fields. Select a field to auto-fill the
        Field ID.
      </p>
      <div>
        <label className="block text-sm font-medium text-[var(--text-main)] mb-2">
          Field ID (optional, recommended)
        </label>
        <input
          type="text"
          value={ruleData.field_id || ""}
          onChange={(e) => updateField("field_id", e.target.value)}
          placeholder="e.g., fldUXiLJmTxJ9aeRp"
          className="w-full p-2 border border-[var(--border)] rounded-lg font-mono text-sm"
        />
        <p className="text-xs text-[var(--text-muted)] mt-1">
          Airtable field ID (starts with "fld"). More reliable than field
          name. Auto-filled when selecting a field above.
        </p>
      </div>
      <div>
        <label className="block text-sm font-medium text-[var(--text-main)] mb-2">
          Message *
        </label>
        <textarea
          value={ruleData.message || ""}
          onChange={(e) => updateField("message", e.target.value)}
          placeholder="Message when field has a value"
          className={`w-full p-2 border rounded-lg ${
            errors.message ? "border-red-500" : "border-[var(--border)]"
          }`}
          rows={2}
        />
        {errors.message && (
          <p className="text-red-500 text-xs mt-1">{errors.message}</p>
        )}
      </div>
      <div>
        <label className="block text-sm font-medium text-[var(--text-main)] mb-2">
          Severity
        </label>
        <select
          value={ruleData.severity || "info"}
          onChange={(e) => updateField("severity", e.target.value)}
          className="w-full p-2 border border-[var(--border)] rounded-lg"
        >
          <option value="info">Info</option>
          <option value="warning">Warning</option>
          <option value="critical">Critical</option>
        </select>
      </div>
    </>
  );

  const renderFields = () => {
    switch (selectedCategory) {
      case "duplicates":
        return renderDuplicateFields();
      case "relationships":
        return renderRelationshipFields();
      case "required_fields":
        return renderRequiredFieldFields();
      case "value_checks":
        return renderValueCheckFields();
      case "attendance_rules":
        return renderAttendanceFields();
      default:
        return <div>Unknown category</div>;
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-0">
      <div
        className="fixed inset-0 bg-neutral-900/50 backdrop-blur-sm transition-opacity"
        onClick={handleClose}
        aria-hidden="true"
      />
      <div className="relative bg-white border border-[var(--border)] rounded-2xl shadow-xl p-6 max-w-2xl w-full mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2
            className="text-2xl font-semibold text-[var(--text-main)]"
            style={{ fontFamily: "Outfit" }}
          >
            {mode === "create" ? "Create Rule" : "Edit Rule"}
          </h2>
          <button
            onClick={handleClose}
            className="text-[var(--text-muted)] hover:text-[var(--text-main)]"
          >
            ✕
          </button>
        </div>

        {/* Edit Mode Tabs */}
        <div className="flex gap-2 mb-4 border-b border-[var(--border)]">
          <button
            type="button"
            onClick={() => {
              if (editMode === "json") {
                try {
                  const parsed = JSON.parse(rawJson) as Record<string, unknown>;
                  if (
                    selectedCategory === "duplicates" &&
                    Array.isArray(parsed.conditions)
                  ) {
                    parsed.conditions = normalizeConditionsForForm(
                      parsed.conditions as Condition[]
                    );
                  }
                  if (
                    selectedCategory === "required_fields" ||
                    selectedCategory === "value_checks"
                  ) {
                    Object.assign(
                      parsed,
                      normalizeRequiredFieldRuleShape(
                        parsed as Record<string, unknown>
                      )
                    );
                  }
                  setRuleData(parsed as Record<string, any>);
                  setRawJson(JSON.stringify(parsed, null, 2));
                  if (
                    selectedCategory === "value_checks" &&
                    typeof parsed.field === "string"
                  ) {
                    setFieldSearchTerm(parsed.field);
                  }
                } catch {
                  /* invalid JSON — keep last ruleData */
                }
              } else {
                setRawJson(JSON.stringify(ruleData, null, 2));
              }
              setEditMode("form");
            }}
            className={`px-4 py-2 font-medium transition-colors ${
              editMode === "form"
                ? "text-[var(--cta-blue)] border-b-2 border-[var(--cta-blue)]"
                : "text-[var(--text-muted)] hover:text-[var(--text-main)]"
            }`}
          >
            Form Editor
          </button>
          <button
            type="button"
            onClick={() => {
              setRawJson(JSON.stringify(ruleData, null, 2));
              setEditMode("json");
            }}
            className={`px-4 py-2 font-medium transition-colors ${
              editMode === "json"
                ? "text-[var(--cta-blue)] border-b-2 border-[var(--cta-blue)]"
                : "text-[var(--text-muted)] hover:text-[var(--text-main)]"
            }`}
          >
            Raw JSON
          </button>
        </div>

        <div className="space-y-4">
          {/* JSON Editor Mode */}
          {editMode === "json" ? (
            <div>
              <label className="block text-sm font-medium text-[var(--text-main)] mb-2">
                Rule JSON
              </label>
              <textarea
                value={rawJson}
                onChange={(e) => {
                  const value = e.target.value;
                  setRawJson(value);
                  // Try to parse and sync to ruleData for live preview
                  try {
                    const parsed = JSON.parse(value) as Record<string, any>;
                    const next =
                      selectedCategory === "required_fields" ||
                      selectedCategory === "value_checks"
                        ? (normalizeRequiredFieldRuleShape(
                            parsed as Record<string, unknown>
                          ) as Record<string, any>)
                        : parsed;
                    setRuleData(next);
                    // Clear JSON error if it exists
                    if (errors.rawJson) {
                      setErrors((prev) => {
                        const newErrors = { ...prev };
                        delete newErrors.rawJson;
                        return newErrors;
                      });
                    }
                  } catch {
                    // Invalid JSON - allow user to continue editing
                  }
                }}
                className={`w-full p-3 border rounded-lg font-mono text-sm ${
                  errors.rawJson
                    ? "border-red-500"
                    : "border-[var(--border)]"
                }`}
                rows={20}
                placeholder='{\n  "rule_id": "required_field_rule.parents.students",\n  "entity": "parents",\n  "field": "Student",\n  "message": "Parents must have at least one student linked.",\n  "severity": "warning",\n  "enabled": true\n}'
              />
              {errors.rawJson && (
                <p className="text-red-500 text-xs mt-1">{errors.rawJson}</p>
              )}
              <p className="text-xs text-[var(--text-muted)] mt-2">
                Edit the complete rule definition as JSON. You can change any field including field names, IDs, and messages.
              </p>
            </div>
          ) : (
            <>
              {/* Form Editor Mode */}
              {/* Rule Type Selection (only for create mode) */}
              {mode === "create" && (
            <div>
              <label className="block text-sm font-medium text-[var(--text-main)] mb-2">
                Rule Type *
              </label>
              <select
                value={selectedCategory}
                onChange={(e) => {
                  setSelectedCategory(e.target.value);
                  setRuleData({}); // Reset rule data when changing category
                  setConditionsJson("");
                  setThresholdsJson("");
                }}
                className="w-full p-2 border border-[var(--border)] rounded-lg"
              >
                {categoryOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Table Selection (only for create mode and non-attendance rules) */}
          {mode === "create" && selectedCategory !== "attendance_rules" && (
            <div>
              <label className="block text-sm font-medium text-[var(--text-main)] mb-2">
                Table *
              </label>
              <select
                value={selectedEntity}
                onChange={(e) => setSelectedEntity(e.target.value)}
                className="w-full p-2 border border-[var(--border)] rounded-lg"
              >
                {ENTITY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          )}

              {/* Rule-specific fields */}
              {renderFields()}
            </>
          )}
        </div>

        <div className="mt-6 flex gap-3">
          <button
            onClick={handleClose}
            className="flex-1 py-2 px-4 border border-[var(--border)] rounded-lg hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="flex-1 py-2 px-4 bg-[var(--cta-blue)] text-white rounded-lg hover:bg-blue-600"
          >
            {mode === "create" ? "Create" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
