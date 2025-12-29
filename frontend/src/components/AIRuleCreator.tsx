import { useState } from "react";
import { useRules } from "../hooks/useRules";

interface AIRuleCreatorProps {
  isOpen: boolean;
  onClose: () => void;
  onRuleParsed: (parsedRule: {
    category: string;
    entity: string | null;
    rule_data: Record<string, any>;
  }) => void;
  currentEntity?: string; // Optional: pre-select the current table
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

export function AIRuleCreator({
  isOpen,
  onClose,
  onRuleParsed,
  currentEntity,
}: AIRuleCreatorProps) {
  const { parseRuleWithAI, loading, error } = useRules();
  const [description, setDescription] = useState("");
  const [categoryHint, setCategoryHint] = useState("");
  const [entityHint, setEntityHint] = useState(currentEntity || "");
  const [autoDetectEntity, setAutoDetectEntity] = useState(!currentEntity);
  const [parsedRule, setParsedRule] = useState<any>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [editableCategory, setEditableCategory] = useState<string>("");
  const [editableRuleData, setEditableRuleData] = useState<string>("");
  const [editableEntity, setEditableEntity] = useState<string>("");
  const [jsonError, setJsonError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleParse = async () => {
    if (!description.trim()) {
      setParseError("Please enter a rule description");
      return;
    }

    setParseError(null);
    try {
      const result = await parseRuleWithAI(
        description,
        categoryHint || undefined
      );

      // Override entity if user selected one manually
      if (!autoDetectEntity && entityHint) {
        result.entity = entityHint;
      }

      setParsedRule(result);
      // Initialize editable fields with parsed values
      setEditableCategory(result.category || "");
      setEditableRuleData(JSON.stringify(result.rule_data || {}, null, 2));
      setEditableEntity(!autoDetectEntity && entityHint ? entityHint : result.entity || "");
      setJsonError(null);
    } catch (err) {
      setParseError(
        err instanceof Error ? err.message : "Failed to parse rule"
      );
    }
  };

  const handleUseRule = () => {
    if (!parsedRule) return;

    // Validate JSON
    let parsedRuleData;
    try {
      parsedRuleData = JSON.parse(editableRuleData);
      setJsonError(null);
    } catch (err) {
      setJsonError("Invalid JSON format. Please fix the syntax errors.");
      return;
    }

    // Validate category
    if (!editableCategory.trim()) {
      setJsonError("Category is required");
      return;
    }

    // Validate entity
    if (!editableEntity.trim()) {
      setJsonError("Entity/Table is required");
      return;
    }

    // Use edited values
    onRuleParsed({
      category: editableCategory.trim(),
      entity: editableEntity.trim(),
      rule_data: parsedRuleData,
    });
    handleClose();
  };

  const handleClose = () => {
    setDescription("");
    setCategoryHint("");
    setEntityHint(currentEntity || "");
    setAutoDetectEntity(!currentEntity);
    setParsedRule(null);
    setParseError(null);
    setEditableCategory("");
    setEditableRuleData("");
    setEditableEntity("");
    setJsonError(null);
    onClose();
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
            Create Rule with AI
          </h2>
          <button
            onClick={handleClose}
            className="text-[var(--text-muted)] hover:text-[var(--text-main)]"
          >
            ✕
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-[var(--text-main)] mb-2">
              Rule Description (Natural Language)
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g., Students must have at least one active parent"
              className="w-full p-3 border border-[var(--border)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--cta-blue)]"
              rows={4}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-[var(--text-main)] mb-2">
              Table/Entity
            </label>
            <div className="flex gap-2 mb-2">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  checked={autoDetectEntity}
                  onChange={() => setAutoDetectEntity(true)}
                  className="w-4 h-4"
                />
                <span className="text-sm">Auto-detect from description</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  checked={!autoDetectEntity}
                  onChange={() => setAutoDetectEntity(false)}
                  className="w-4 h-4"
                />
                <span className="text-sm">Select manually</span>
              </label>
            </div>
            {!autoDetectEntity && (
              <select
                value={entityHint}
                onChange={(e) => setEntityHint(e.target.value)}
                className="w-full p-3 border border-[var(--border)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--cta-blue)]"
              >
                <option value="">Select a table...</option>
                {ENTITY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-[var(--text-main)] mb-2">
              Rule Type (Optional)
            </label>
            <select
              value={categoryHint}
              onChange={(e) => setCategoryHint(e.target.value)}
              className="w-full p-3 border border-[var(--border)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--cta-blue)]"
            >
              <option value="">Auto-detect</option>
              <option value="duplicates">Duplicate Detection</option>
              <option value="relationships">Relationship</option>
              <option value="required_fields">Required Field</option>
              <option value="attendance_rules">Attendance Rule</option>
            </select>
          </div>

          <button
            onClick={handleParse}
            disabled={loading || !description.trim()}
            className="w-full py-2 px-4 bg-[var(--cta-blue)] text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? "Parsing..." : "Parse with AI"}
          </button>

          {(error || parseError) && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-800 text-sm">
              {error || parseError}
            </div>
          )}

          {parsedRule && (
            <div className="mt-4 p-4 bg-green-50 border border-green-200 rounded-lg">
              <h3 className="font-semibold text-green-800 mb-3">
                Parsed Rule (Edit before submitting):
              </h3>
              <div className="bg-white p-4 rounded border border-green-300 space-y-4">
                <div>
                  <label className="block text-sm font-medium text-[var(--text-main)] mb-2">
                    Rule Type (Category) *
                  </label>
                  <select
                    value={editableCategory}
                    onChange={(e) => setEditableCategory(e.target.value)}
                    className="w-full p-2 border border-[var(--border)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--cta-blue)]"
                  >
                    <option value="">Select category...</option>
                    <option value="duplicates">Duplicate Detection</option>
                    <option value="relationships">Relationship</option>
                    <option value="required_fields">Required Field</option>
                    <option value="attendance_rules">Attendance Rule</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-[var(--text-main)] mb-2">
                    Table/Entity *
                  </label>
                  <select
                    value={editableEntity}
                    onChange={(e) => setEditableEntity(e.target.value)}
                    className="w-full p-2 border border-[var(--border)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--cta-blue)]"
                  >
                    <option value="">Select a table...</option>
                    {ENTITY_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>

                 {/* Field Lookup Status Indicator */}
                 {parsedRule?.rule_data?.field_lookup_status && (
                   <div className={`p-3 rounded-lg border ${
                     parsedRule.rule_data.field_lookup_status === "found" || parsedRule.rule_data.field_lookup_status === "found_partial"
                       ? "bg-green-50 border-green-200"
                       : parsedRule.rule_data.field_lookup_status === "field_not_found" || parsedRule.rule_data.field_lookup_status === "table_not_found"
                       ? "bg-yellow-50 border-yellow-200"
                       : "bg-red-50 border-red-200"
                   }`}>
                     <div className="flex items-start gap-2">
                       {parsedRule.rule_data.field_lookup_status === "found" || parsedRule.rule_data.field_lookup_status === "found_partial" ? (
                         <span className="text-green-600">✓</span>
                       ) : (
                         <span className="text-yellow-600">⚠</span>
                       )}
                       <div className="flex-1">
                         <div className="text-sm font-medium text-[var(--text-main)] mb-1">
                           Field Lookup: {parsedRule.rule_data.field_lookup_status === "found" ? "Found" : 
                                         parsedRule.rule_data.field_lookup_status === "found_partial" ? "Found (Partial Match)" :
                                         parsedRule.rule_data.field_lookup_status === "field_not_found" ? "Field Not Found" :
                                         parsedRule.rule_data.field_lookup_status === "table_not_found" ? "Table Not Found" :
                                         parsedRule.rule_data.field_lookup_status === "schema_not_found" ? "Schema Not Found" :
                                         "Error"}
                         </div>
                         {parsedRule.rule_data.field_lookup_message && (
                           <div className="text-xs text-[var(--text-muted)]">
                             {parsedRule.rule_data.field_lookup_message}
                           </div>
                         )}
                         {parsedRule.rule_data.field_id && (
                           <div className="text-xs font-mono text-[var(--text-muted)] mt-1">
                             Field ID: {parsedRule.rule_data.field_id}
                           </div>
                         )}
                       </div>
                     </div>
                   </div>
                 )}

                 <div>
                   <label className="block text-sm font-medium text-[var(--text-main)] mb-2">
                     Rule Data (JSON) *
                   </label>
                   <textarea
                     value={editableRuleData}
                     onChange={(e) => {
                       setEditableRuleData(e.target.value);
                       // Validate JSON on change
                       try {
                         JSON.parse(e.target.value);
                         setJsonError(null);
                       } catch {
                         // Don't show error while typing, only on submit
                       }
                     }}
                     className={`w-full p-3 border rounded-lg font-mono text-sm focus:outline-none focus:ring-2 focus:ring-[var(--cta-blue)] ${
                       jsonError ? "border-red-500" : "border-[var(--border)]"
                     }`}
                     rows={12}
                     placeholder='{"field": "email", "message": "Email is required", "severity": "warning"}'
                   />
                   {jsonError && (
                     <p className="text-red-500 text-xs mt-1">{jsonError}</p>
                   )}
                   <p className="text-xs text-[var(--text-muted)] mt-1">
                     Edit the JSON data as needed. Invalid JSON will prevent submission.
                   </p>
                 </div>
              </div>
              <button
                onClick={handleUseRule}
                className="mt-3 w-full py-2 px-4 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={!editableCategory || !editableEntity || !editableRuleData.trim()}
              >
                Submit Rule
              </button>
            </div>
          )}
        </div>

        <div className="mt-6 flex gap-3">
          <button
            onClick={handleClose}
            className="flex-1 py-2 px-4 border border-[var(--border)] rounded-lg hover:bg-gray-50"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
