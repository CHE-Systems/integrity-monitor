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
    } catch (err) {
      setParseError(
        err instanceof Error ? err.message : "Failed to parse rule"
      );
    }
  };

  const handleUseRule = () => {
    if (parsedRule) {
      // Final check: use manual entity selection if provided
      const finalEntity = !autoDetectEntity && entityHint
        ? entityHint
        : parsedRule.entity;

      onRuleParsed({
        category: parsedRule.category,
        entity: finalEntity,
        rule_data: parsedRule.rule_data,
      });
      handleClose();
    }
  };

  const handleClose = () => {
    setDescription("");
    setCategoryHint("");
    setEntityHint(currentEntity || "");
    setAutoDetectEntity(!currentEntity);
    setParsedRule(null);
    setParseError(null);
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
              <h3 className="font-semibold text-green-800 mb-2">
                Parsed Rule:
              </h3>
              <div className="bg-white p-3 rounded border border-green-300">
                <div className="mb-2">
                  <span className="font-medium">Rule Type:</span>{" "}
                  <span className="px-2 py-1 text-xs bg-blue-100 text-blue-800 rounded ml-1">
                    {parsedRule.category}
                  </span>
                </div>
                <div className="mb-2">
                  <span className="font-medium">Table:</span>{" "}
                  <span className="px-2 py-1 text-xs bg-green-100 text-green-800 rounded ml-1 capitalize">
                    {!autoDetectEntity && entityHint
                      ? entityHint
                      : parsedRule.entity || "Not specified"}
                  </span>
                  {!autoDetectEntity && entityHint && entityHint !== parsedRule.entity && (
                    <span className="text-xs text-gray-600 ml-2">
                      (Manually selected: {entityHint})
                    </span>
                  )}
                </div>
                {parsedRule.category === "required_fields" && parsedRule.rule_data?.field_id && (
                  <div className="mb-2">
                    <span className="font-medium">Field ID:</span>{" "}
                    <span className="px-2 py-1 text-xs bg-purple-100 text-purple-800 rounded ml-1 font-mono">
                      {parsedRule.rule_data.field_id}
                    </span>
                    <span className="text-xs text-gray-600 ml-2">
                      (Auto-detected from schema)
                    </span>
                  </div>
                )}
                <div className="mb-2">
                  <span className="font-medium">Rule Data:</span>
                </div>
                <pre className="text-xs bg-gray-50 p-2 rounded overflow-x-auto max-h-60">
                  {JSON.stringify(parsedRule.rule_data, null, 2)}
                </pre>
              </div>
              <button
                onClick={handleUseRule}
                className="mt-3 w-full py-2 px-4 bg-green-600 text-white rounded-lg hover:bg-green-700"
              >
                Use This Rule
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
