import { useState, useEffect } from "react";
import { useAuth } from "../hooks/useAuth";
import { API_BASE } from "../config/api";

interface RuleEditorProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (ruleData: Record<string, any>, category: string, entity: string | null) => void;
  category?: string;
  entity?: string;
  initialRule?: Record<string, any>;
  mode: "create" | "edit";
  currentEntity?: string; // Current table being viewed
}

const ENTITY_OPTIONS = [
  { value: "students", label: "Students" },
  { value: "parents", label: "Parents" },
  { value: "contractors", label: "Contractors" },
  { value: "classes", label: "Classes" },
  { value: "attendance", label: "Attendance" },
  { value: "truth", label: "Truth" },
  { value: "student_truth", label: "Student Truth" },
  { value: "payments", label: "Payments" },
];

const CATEGORY_OPTIONS = [
  { value: "duplicates", label: "Duplicate Detection" },
  { value: "relationships", label: "Relationship" },
  { value: "required_fields", label: "Required Field" },
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

  useEffect(() => {
    if (initialRule) {
      setRuleData(initialRule);
    } else {
      setRuleData({});
    }
    setSelectedCategory(initialCategory || "duplicates");
    setSelectedEntity(initialEntity || currentEntity || "students");
    setErrors({});
  }, [initialRule, initialCategory, initialEntity, currentEntity, isOpen]);

  if (!isOpen) return null;

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {};

    if (selectedCategory === "duplicates") {
      if (!ruleData.description)
        newErrors.description = "Description is required";
      if (!ruleData.rule_id && mode === "create")
        newErrors.rule_id = "Rule ID is required";
      if (!ruleData.conditions || ruleData.conditions.length === 0) {
        newErrors.conditions = "At least one condition is required";
      }
    } else if (selectedCategory === "relationships") {
      if (!ruleData.target) newErrors.target = "Target entity is required";
      if (!ruleData.message) newErrors.message = "Message is required";
    } else if (selectedCategory === "required_fields") {
      if (!ruleData.field) newErrors.field = "Field name is required";
      if (!ruleData.message) newErrors.message = "Message is required";
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSave = () => {
    if (validate()) {
      onSave(ruleData, selectedCategory, selectedEntity);
      handleClose();
    }
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
          value={ruleData.severity || "likely"}
          onChange={(e) => updateField("severity", e.target.value)}
          className="w-full p-2 border border-[var(--border)] rounded-lg"
        >
          <option value="likely">Likely (High Confidence)</option>
          <option value="possible">Possible (Low Confidence)</option>
        </select>
      </div>
      <div>
        <label className="block text-sm font-medium text-[var(--text-main)] mb-2">
          Conditions (JSON) *
        </label>
        <textarea
          value={JSON.stringify(ruleData.conditions || [], null, 2)}
          onChange={(e) => {
            try {
              updateField("conditions", JSON.parse(e.target.value));
            } catch {
              // Invalid JSON, keep as is
            }
          }}
          placeholder='[{"field": "email", "match_type": "exact"}, ...]'
          className={`w-full p-2 border rounded-lg font-mono text-sm ${
            errors.conditions ? "border-red-500" : "border-[var(--border)]"
          }`}
          rows={6}
        />
        {errors.conditions && (
          <p className="text-red-500 text-xs mt-1">{errors.conditions}</p>
        )}
      </div>
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

  const renderRequiredFieldFields = () => {
    const [fieldSearchTerm, setFieldSearchTerm] = useState("");
    const [fieldOptions, setFieldOptions] = useState<Array<{id: string; name: string}>>([]);
    const [fieldLookupLoading, setFieldLookupLoading] = useState(false);

    // Lookup fields when search term changes
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
            `${API_BASE}/airtable/schema/fields/${selectedEntity}?search=${encodeURIComponent(fieldSearchTerm)}`,
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

      const timeoutId = setTimeout(lookupFields, 300); // Debounce
      return () => clearTimeout(timeoutId);
    }, [fieldSearchTerm, selectedEntity]);

    const handleFieldSelect = (fieldId: string, fieldName: string) => {
      updateField("field", fieldName);
      updateField("field_id", fieldId);
      setFieldSearchTerm("");
      setFieldOptions([]);
    };

    return (
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
              <div className="absolute right-2 top-2 text-gray-400 text-sm">Searching...</div>
            )}
          </div>
          {errors.field && (
            <p className="text-red-500 text-xs mt-1">{errors.field}</p>
          )}
          <p className="text-xs text-[var(--text-muted)] mt-1">
            Start typing to search for fields. Select a field to auto-fill the Field ID.
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
            Airtable field ID (starts with "fld"). More reliable than field name. Auto-filled when selecting a field above.
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
  };

  const renderAttendanceFields = () => (
    <div>
      <label className="block text-sm font-medium text-[var(--text-main)] mb-2">
        Thresholds (JSON)
      </label>
      <textarea
        value={JSON.stringify(ruleData.thresholds || {}, null, 2)}
        onChange={(e) => {
          try {
            updateField("thresholds", JSON.parse(e.target.value));
          } catch {
            // Invalid JSON
          }
        }}
        className="w-full p-2 border border-[var(--border)] rounded-lg font-mono text-sm"
        rows={8}
      />
    </div>
  );

  const renderFields = () => {
    switch (selectedCategory) {
      case "duplicates":
        return renderDuplicateFields();
      case "relationships":
        return renderRelationshipFields();
      case "required_fields":
        return renderRequiredFieldFields();
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

        <div className="space-y-4">
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
                }}
                className="w-full p-2 border border-[var(--border)] rounded-lg"
              >
                {CATEGORY_OPTIONS.map((option) => (
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
