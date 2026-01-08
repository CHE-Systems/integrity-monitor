import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useRules } from "../hooks/useRules";
import { useAuth } from "../hooks/useAuth";
import { RuleEditor } from "../components/RuleEditor";
import ConfirmModal from "../components/ConfirmModal";
import trashIcon from "../assets/trash.svg";

export function RuleDetailPage() {
  const { category, entity, ruleId } = useParams<{
    category: string;
    entity?: string;
    ruleId: string;
  }>();
  const navigate = useNavigate();
  const { loading: authLoading } = useAuth();
  const { loadRules, updateRule, deleteRule, loading, error } = useRules();
  const [rules, setRules] = useState<any>(null);
  const [rule, setRule] = useState<Record<string, any> | null>(null);
  const [isLoadingRule, setIsLoadingRule] = useState(true);
  const [showEditor, setShowEditor] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [copySuccess, setCopySuccess] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!category || !ruleId) return;

    // Wait for auth to be ready before loading rules
    if (authLoading) return;

    const fetchRule = async () => {
      setIsLoadingRule(true);
      try {
        const allRules = await loadRules();
        setRules(allRules);

        // Find the specific rule
        let foundRule: Record<string, any> | null = null;

        if (category === "duplicates" && entity) {
          const entityRules = allRules.duplicates?.[entity];
          if (entityRules) {
            // Check likely and possible arrays
            const likely = entityRules.likely || [];
            const possible = entityRules.possible || [];
            // Try to find by full rule_id first, then by field name (last part of rule_id)
            foundRule =
              likely.find((r: any) => r.rule_id === ruleId) ||
              possible.find((r: any) => r.rule_id === ruleId) ||
              likely.find((r: any) => {
                const parts = r.rule_id?.split(".");
                return parts && parts.length >= 3 && parts[parts.length - 1] === ruleId;
              }) ||
              possible.find((r: any) => {
                const parts = r.rule_id?.split(".");
                return parts && parts.length >= 3 && parts[parts.length - 1] === ruleId;
              }) ||
              null;
          }
        } else if (category === "relationships" && entity) {
          const entityRels = allRules.relationships?.[entity];
          if (entityRels && ruleId) {
            foundRule = entityRels[ruleId] || null;
          }
        } else if (category === "required_fields" && entity) {
          const entityFields = allRules.required_fields?.[entity];
          if (entityFields) {
            foundRule =
              entityFields.find(
                (r: any) => r.field === ruleId || r.rule_id === ruleId
              ) || null;
          }
        } else if (category === "value_checks" && entity) {
          const entityValueChecks = allRules.value_checks?.[entity];
          if (entityValueChecks) {
            foundRule =
              entityValueChecks.find(
                (r: any) => r.field === ruleId || r.rule_id === ruleId || r.field_name === ruleId
              ) || null;
          }
        } else if (category === "attendance_rules") {
          foundRule = allRules.attendance_rules || null;
        }

        if (foundRule) {
          setRule(foundRule);
        }
      } catch (err) {
        console.error("Failed to load rule:", err);
      } finally {
        setIsLoadingRule(false);
      }
    };

    fetchRule();
  }, [category, entity, ruleId, loadRules, authLoading]);

  const handleCopy = async () => {
    if (!rule) return;

    try {
      const ruleText =
        rule.source === "yaml"
          ? formatAsYAML(rule, category, entity)
          : JSON.stringify(rule, null, 2);

      await navigator.clipboard.writeText(ruleText);
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  const formatAsYAML = (
    rule: Record<string, any>,
    category: string,
    entity?: string
  ): string => {
    // Simple YAML formatting
    const lines: string[] = [];

    if (category === "duplicates") {
      lines.push(`rule_id: ${rule.rule_id || ""}`);
      lines.push(`description: ${rule.description || ""}`);
      lines.push(`severity: ${rule.severity || "warning"}`);
      if (rule.conditions) {
        lines.push("conditions:");
        rule.conditions.forEach((cond: any) => {
          lines.push(`  - type: ${cond.type}`);
          if (cond.field) lines.push(`    field: ${cond.field}`);
          if (cond.fields)
            lines.push(`    fields: [${cond.fields.join(", ")}]`);
          if (cond.similarity) lines.push(`    similarity: ${cond.similarity}`);
        });
      }
    } else if (category === "relationships") {
      lines.push(`target: ${rule.target || ""}`);
      lines.push(`message: ${rule.message || ""}`);
      lines.push(`min_links: ${rule.min_links || 0}`);
      if (rule.max_links !== null && rule.max_links !== undefined) {
        lines.push(`max_links: ${rule.max_links}`);
      }
      lines.push(`require_active: ${rule.require_active || false}`);
    } else if (category === "required_fields") {
      lines.push(`field: ${rule.field || ""}`);
      lines.push(`message: ${rule.message || ""}`);
      lines.push(`severity: ${rule.severity || "warning"}`);
      if (rule.alternate_fields) {
        lines.push(`alternate_fields: [${rule.alternate_fields.join(", ")}]`);
      }
    } else if (category === "attendance_rules") {
      lines.push(`onboarding_grace_days: ${rule.onboarding_grace_days || 7}`);
      lines.push(
        `limited_schedule_threshold: ${rule.limited_schedule_threshold || 3}`
      );
      if (rule.thresholds) {
        lines.push("thresholds:");
        Object.entries(rule.thresholds).forEach(
          ([key, value]: [string, any]) => {
            lines.push(`  ${key}:`);
            if (value.info !== undefined) lines.push(`    info: ${value.info}`);
            if (value.warning !== undefined)
              lines.push(`    warning: ${value.warning}`);
            if (value.critical !== undefined)
              lines.push(`    critical: ${value.critical}`);
          }
        );
      }
    }

    return lines.join("\n");
  };

  const handleSaveRule = async (ruleData: Record<string, any>) => {
    if (!category || !ruleId) return;

    try {
      await updateRule(category, ruleId, entity || null, ruleData);
      // Reload rule
      const allRules = await loadRules();
      setRules(allRules);

      // Find updated rule
      let foundRule: Record<string, any> | null = null;
      if (category === "duplicates" && entity) {
        const entityRules = allRules.duplicates?.[entity];
        if (entityRules) {
          const likely = entityRules.likely || [];
          const possible = entityRules.possible || [];
          foundRule =
            likely.find((r: any) => r.rule_id === ruleId) ||
            possible.find((r: any) => r.rule_id === ruleId) ||
            null;
        }
      } else if (category === "relationships" && entity) {
        foundRule = allRules.relationships?.[entity]?.[ruleId] || null;
      } else if (category === "required_fields" && entity) {
        foundRule =
          allRules.required_fields?.[entity]?.find(
            (r: any) => r.field === ruleId || r.rule_id === ruleId
          ) || null;
      } else if (category === "attendance_rules") {
        foundRule = allRules.attendance_rules || null;
      }

      if (foundRule) {
        setRule(foundRule);
      }
      setShowEditor(false);
    } catch (err) {
      console.error("Failed to save rule:", err);
    }
  };

  const handleDelete = async () => {
    if (!category || !ruleId) return;

    setShowDeleteConfirm(false);
    setDeleting(true);
    try {
      await deleteRule(category, ruleId, entity || null);
      navigate("/rules");
    } catch (err) {
      console.error("Failed to delete rule:", err);
      setDeleting(false);
    }
  };

  if (loading || isLoadingRule) {
    return (
      <div className="text-center py-12">
        <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--brand)] mb-4"></div>
        <p className="text-[var(--text-muted)]">Loading rule details...</p>
      </div>
    );
  }

  if (error || !rule) {
    return (
      <div className="rounded-lg bg-red-50 border border-red-200 px-6 py-4">
        <p className="text-red-700">{error || "Rule not found"}</p>
        <button
          onClick={() => navigate("/rules")}
          className="mt-4 text-sm text-red-600 hover:text-red-800 underline"
        >
          ← Back to Rules
        </button>
      </div>
    );
  }

  const source = rule.source || "yaml";
  const isFirestore = source === "firestore";
  const ruleText =
    source === "yaml"
      ? formatAsYAML(rule, category || "", entity)
      : JSON.stringify(rule, null, 2);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <button
          onClick={() => navigate("/rules")}
          className="text-sm text-[var(--text-muted)] hover:text-[var(--text-main)]"
        >
          ← Back to Rules
        </button>
        {isFirestore && (
          <div className="flex gap-2">
            <button
              onClick={() => setShowEditor(true)}
              className="px-4 py-2 text-sm font-medium text-[var(--text-main)] bg-[var(--bg-mid)] hover:bg-[var(--bg-mid)]/80 rounded-lg"
            >
              Edit
            </button>
            <button
              onClick={() => setShowDeleteConfirm(true)}
              disabled={deleting}
              className="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg disabled:opacity-50 flex items-center gap-2"
            >
              <img
                src={trashIcon}
                alt="Delete"
                className="w-4 h-4"
                style={{
                  filter: "brightness(0) invert(1)",
                }}
              />
              {deleting ? "Deleting..." : "Delete"}
            </button>
          </div>
        )}
      </div>

      <div className="rounded-3xl border border-[var(--border)] bg-white p-6 space-y-6">
        <div>
          <h1
            className="text-2xl font-semibold text-[var(--text-main)] mb-2"
            style={{ fontFamily: "Outfit" }}
          >
            Rule Details
          </h1>
          <div className="flex items-center gap-3 mt-4">
            <span className="px-3 py-1 text-sm font-medium bg-gray-100 text-gray-800 rounded capitalize">
              {category}
            </span>
            {entity && entity !== "_" && (
              <span className="px-3 py-1 text-sm font-medium bg-gray-100 text-gray-800 rounded capitalize">
                {entity}
              </span>
            )}
            {isFirestore ? (
              <span className="px-3 py-1 text-sm font-medium bg-blue-100 text-blue-800 rounded">
                Firestore
              </span>
            ) : (
              <span className="px-3 py-1 text-sm font-medium bg-gray-100 text-gray-800 rounded">
                YAML Base
              </span>
            )}
            {rule.severity && (
              <span
                className={`px-3 py-1 text-sm font-medium rounded ${
                  rule.severity === "critical"
                    ? "bg-red-100 text-red-800"
                    : rule.severity === "warning"
                    ? "bg-yellow-100 text-yellow-800"
                    : "bg-blue-100 text-blue-800"
                }`}
              >
                {rule.severity}
              </span>
            )}
          </div>
        </div>

        <div className="grid gap-6 md:grid-cols-2">
          <div className="space-y-4">
            <div>
              <h3 className="text-sm font-medium text-[var(--text-muted)] mb-2">
                Rule ID
              </h3>
              <p className="text-sm text-[var(--text-main)] font-mono">
                {rule.rule_id || ruleId || rule.field || "N/A"}
              </p>
            </div>

            {entity && entity !== "_" && (
              <div>
                <h3 className="text-sm font-medium text-[var(--text-muted)] mb-2">
                  Entity
                </h3>
                <p className="text-sm text-[var(--text-main)] capitalize">
                  {entity}
                </p>
              </div>
            )}

            {rule.description && (
              <div>
                <h3 className="text-sm font-medium text-[var(--text-muted)] mb-2">
                  Description
                </h3>
                <p className="text-sm text-[var(--text-main)]">
                  {rule.description}
                </p>
              </div>
            )}

            {rule.message && (
              <div>
                <h3 className="text-sm font-medium text-[var(--text-muted)] mb-2">
                  Message
                </h3>
                <p className="text-sm text-[var(--text-main)]">
                  {rule.message}
                </p>
              </div>
            )}
          </div>

          <div className="space-y-4">
            {category === "relationships" && (
              <>
                <div>
                  <h3 className="text-sm font-medium text-[var(--text-muted)] mb-2">
                    Target Entity
                  </h3>
                  <p className="text-sm text-[var(--text-main)] capitalize">
                    {rule.target}
                  </p>
                </div>
                <div>
                  <h3 className="text-sm font-medium text-[var(--text-muted)] mb-2">
                    Link Requirements
                  </h3>
                  <p className="text-sm text-[var(--text-main)]">
                    Min: {rule.min_links || 0} | Max: {rule.max_links || "∞"}
                  </p>
                </div>
                {rule.require_active && (
                  <div>
                    <h3 className="text-sm font-medium text-[var(--text-muted)] mb-2">
                      Require Active
                    </h3>
                    <p className="text-sm text-[var(--text-main)]">Yes</p>
                  </div>
                )}
              </>
            )}

            {category === "required_fields" && (
              <>
                <div>
                  <h3 className="text-sm font-medium text-[var(--text-muted)] mb-2">
                    Field Name
                  </h3>
                  <p className="text-sm text-[var(--text-main)] font-mono">
                    {rule.field}
                  </p>
                </div>
                {rule.alternate_fields && rule.alternate_fields.length > 0 && (
                  <div>
                    <h3 className="text-sm font-medium text-[var(--text-muted)] mb-2">
                      Alternate Fields
                    </h3>
                    <p className="text-sm text-[var(--text-main)]">
                      {rule.alternate_fields.join(", ")}
                    </p>
                  </div>
                )}
              </>
            )}

            {category === "attendance_rules" && (
              <>
                <div>
                  <h3 className="text-sm font-medium text-[var(--text-muted)] mb-2">
                    Onboarding Grace Days
                  </h3>
                  <p className="text-sm text-[var(--text-main)]">
                    {rule.onboarding_grace_days || 7}
                  </p>
                </div>
                <div>
                  <h3 className="text-sm font-medium text-[var(--text-muted)] mb-2">
                    Limited Schedule Threshold
                  </h3>
                  <p className="text-sm text-[var(--text-main)]">
                    {rule.limited_schedule_threshold || 3}
                  </p>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="border-t border-[var(--border)] pt-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-[var(--text-main)]">
              Rule Definition
            </h3>
            <div className="flex items-center gap-2">
              {copySuccess && (
                <span className="text-sm text-green-600">Copied!</span>
              )}
              <button
                onClick={handleCopy}
                className="px-4 py-2 text-sm font-medium text-[var(--cta-blue)] hover:bg-blue-50 rounded-lg border border-[var(--border)]"
              >
                Copy {source === "yaml" ? "YAML" : "JSON"}
              </button>
            </div>
          </div>
          <div className="bg-gray-50 rounded-lg p-4 overflow-x-auto">
            <pre className="text-sm font-mono text-[var(--text-main)]">
              <code>{ruleText}</code>
            </pre>
          </div>
        </div>
      </div>

      {showEditor && rule && (
        <RuleEditor
          isOpen={showEditor}
          onClose={() => setShowEditor(false)}
          onSave={handleSaveRule}
          category={category || ""}
          entity={entity}
          initialRule={rule}
          mode="edit"
        />
      )}

      <ConfirmModal
        isOpen={showDeleteConfirm}
        title="Delete Rule"
        message="Are you sure you want to delete this rule? This action cannot be undone."
        confirmLabel="Delete"
        cancelLabel="Cancel"
        isDestructive={true}
        onConfirm={handleDelete}
        onCancel={() => setShowDeleteConfirm(false)}
      />
    </div>
  );
}
