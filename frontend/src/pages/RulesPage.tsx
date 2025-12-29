import { useState, useEffect, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useRules } from "../hooks/useRules";
import type { RulesByCategory } from "../hooks/useRules";
import { useAuth } from "../hooks/useAuth";
import { RuleEditor } from "../components/RuleEditor";
import { AIRuleCreator } from "../components/AIRuleCreator";
import ConfirmModal from "../components/ConfirmModal";
import trashIcon from "../assets/trash.svg";
import { formatRuleId } from "../utils/ruleFormatter";

type EntityName = string;

// Map of entity names to display names
const ENTITY_DISPLAY_NAMES: Record<string, string> = {
  students: "Students",
  parents: "Parents",
  contractors: "Contractors",
  classes: "Classes",
  attendance: "Attendance",
  truth: "Truth",
  student_truth: "Student Truth",
  payments: "Payments",
};

// Entity-centric structure
interface EntityRules {
  entity: string;
  duplicates: {
    likely: any[];
    possible: any[];
  };
  relationships: Record<string, any>;
  required_fields: any[];
}

export function RulesPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const { loadRules, createRule, updateRule, deleteRule, loading, error } =
    useRules();
  const [rules, setRules] = useState<RulesByCategory | null>(null);
  const entityFromUrl = searchParams.get("entity") || "students";
  const [activeEntity, setActiveEntity] = useState<EntityName>(entityFromUrl);
  const [showAICreator, setShowAICreator] = useState(false);
  const [showEditor, setShowEditor] = useState(false);
  const [editingRule, setEditingRule] = useState<{
    category: string;
    entity?: string;
    ruleId: string;
    rule: Record<string, any>;
  } | null>(null);
  const [deletingRule, setDeletingRule] = useState<{
    category: string;
    entity?: string;
    ruleId: string;
  } | null>(null);
  const entityTabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [highlightedEntity, setHighlightedEntity] = useState<string | null>(
    null
  );

  useEffect(() => {
    // Only fetch rules if user is authenticated
    if (user) {
      fetchRules();
    }
  }, [user]);

  // Handle entity from URL parameter
  useEffect(() => {
    const entityParam = searchParams.get("entity");
    if (entityParam) {
      // Only update if different from current active entity
      if (entityParam !== activeEntity) {
        setActiveEntity(entityParam);
      }
      // Highlight the entity tab
      setHighlightedEntity(entityParam);
      // Scroll to the entity tab if it exists
      setTimeout(() => {
        const tabRef = entityTabRefs.current[entityParam];
        if (tabRef) {
          tabRef.scrollIntoView({
            behavior: "smooth",
            block: "nearest",
            inline: "center",
          });
        }
      }, 100);
      // Remove highlight after 3 seconds
      setTimeout(() => {
        setHighlightedEntity(null);
        // Remove query parameter after highlighting
        const newParams = new URLSearchParams(searchParams);
        newParams.delete("entity");
        setSearchParams(newParams, { replace: true });
      }, 3000);
    }
  }, [searchParams, activeEntity, setSearchParams]);

  const fetchRules = async () => {
    try {
      const data = await loadRules();
      setRules(data);
    } catch (err) {
      console.error("Failed to load rules:", err);
      // Set empty rules structure on error so UI doesn't hang
      setRules({
        duplicates: {},
        relationships: {},
        required_fields: {},
        attendance_rules: {},
      });
    }
  };

  const handleCreateRule = async (parsedRule: {
    category: string;
    entity: string | null;
    rule_data: Record<string, any>;
  }) => {
    try {
      await createRule(
        parsedRule.category,
        parsedRule.entity,
        parsedRule.rule_data
      );
      await fetchRules();
      setShowAICreator(false);
    } catch (err) {
      console.error("Failed to create rule:", err);
    }
  };

  const handleSaveRule = async (
    ruleData: Record<string, any>,
    category: string,
    entity: string | null
  ) => {
    if (!editingRule) return;

    try {
      if (editingRule.ruleId) {
        await updateRule(category, editingRule.ruleId, entity, ruleData);
      } else {
        await createRule(category, entity, ruleData);
      }
      await fetchRules();
      setShowEditor(false);
      setEditingRule(null);
    } catch (err) {
      console.error("Failed to save rule:", err);
    }
  };

  const handleEditClick = (
    category: string,
    entity: string | undefined,
    ruleId: string,
    rule: Record<string, any>
  ) => {
    setEditingRule({ category, entity, ruleId, rule });
    setShowEditor(true);
  };

  const handleDeleteClick = (
    category: string,
    entity: string | undefined,
    ruleId: string
  ) => {
    setDeletingRule({ category, entity, ruleId });
  };

  const handleConfirmDelete = async () => {
    if (!deletingRule) return;

    try {
      await deleteRule(
        deletingRule.category,
        deletingRule.ruleId,
        deletingRule.entity || null
      );
      await fetchRules();
      setDeletingRule(null);
    } catch (err) {
      console.error("Failed to delete rule:", err);
      const errorMessage =
        err instanceof Error ? err.message : "Failed to delete rule";
      alert(`Failed to delete rule: ${errorMessage}`);
      setDeletingRule(null);
    }
  };

  // Reorganize rules by entity
  const getEntitiesWithRules = (): EntityName[] => {
    if (!rules) return [];

    const entities = new Set<string>();

    // Collect entities from all rule types
    Object.keys(rules.duplicates || {}).forEach((e) => entities.add(e));
    Object.keys(rules.relationships || {}).forEach((e) => entities.add(e));
    Object.keys(rules.required_fields || {}).forEach((e) => entities.add(e));

    return Array.from(entities).sort();
  };

  const getEntityRules = (entity: string): EntityRules => {
    return {
      entity,
      duplicates: (rules?.duplicates?.[entity] as any) || {
        likely: [],
        possible: [],
      },
      relationships: (rules?.relationships?.[entity] as any) || {},
      required_fields: (rules?.required_fields?.[entity] as any[]) || [],
    };
  };

  const renderEntityRules = () => {
    const entityRules = getEntityRules(activeEntity);

    const totalRules =
      (entityRules.duplicates.likely?.length || 0) +
      (entityRules.duplicates.possible?.length || 0) +
      Object.keys(entityRules.relationships).length +
      (entityRules.required_fields?.length || 0);

    if (totalRules === 0) {
      return (
        <div className="text-center py-12 text-[var(--text-muted)]">
          <p className="text-lg mb-2">No rules configured for {activeEntity}</p>
          <p className="text-sm">
            Create your first rule using the buttons above
          </p>
        </div>
      );
    }

    return (
      <div className="space-y-8">
        {/* Duplicate Rules */}
        {(entityRules.duplicates.likely?.length > 0 ||
          entityRules.duplicates.possible?.length > 0) && (
          <div>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-[var(--text-main)]">
                Duplicate Detection Rules
              </h3>
              <button
                onClick={() => {
                  setEditingRule({
                    category: "duplicates",
                    entity: activeEntity,
                    ruleId: "",
                    rule: {},
                  });
                  setShowEditor(true);
                }}
                className="px-3 py-1.5 text-sm border border-[var(--border)] rounded-lg hover:bg-gray-50"
              >
                + Add Duplicate Rule
              </button>
            </div>

            {entityRules.duplicates.likely?.length > 0 && (
              <div className="mb-4">
                <h4 className="text-sm font-medium text-[var(--text-muted)] mb-2">
                  Likely Duplicates
                </h4>
                <div className="space-y-3">
                  {entityRules.duplicates.likely.map(
                    (rule: any, idx: number) => (
                      <RuleCard
                        key={idx}
                        rule={rule}
                        entity={activeEntity}
                        category="duplicates"
                        ruleId={rule.rule_id}
                        onView={() =>
                          navigate(
                            `/rules/duplicates/${activeEntity}/${rule.rule_id}`
                          )
                        }
                        onEdit={() =>
                          handleEditClick(
                            "duplicates",
                            activeEntity,
                            rule.rule_id,
                            rule
                          )
                        }
                        onDelete={() =>
                          handleDeleteClick(
                            "duplicates",
                            activeEntity,
                            rule.rule_id
                          )
                        }
                      />
                    )
                  )}
                </div>
              </div>
            )}

            {entityRules.duplicates.possible?.length > 0 && (
              <div>
                <h4 className="text-sm font-medium text-[var(--text-muted)] mb-2">
                  Possible Duplicates
                </h4>
                <div className="space-y-3">
                  {entityRules.duplicates.possible.map(
                    (rule: any, idx: number) => (
                      <RuleCard
                        key={idx}
                        rule={rule}
                        entity={activeEntity}
                        category="duplicates"
                        ruleId={rule.rule_id}
                        onView={() =>
                          navigate(
                            `/rules/duplicates/${activeEntity}/${rule.rule_id}`
                          )
                        }
                        onEdit={() =>
                          handleEditClick(
                            "duplicates",
                            activeEntity,
                            rule.rule_id,
                            rule
                          )
                        }
                        onDelete={() =>
                          handleDeleteClick(
                            "duplicates",
                            activeEntity,
                            rule.rule_id
                          )
                        }
                      />
                    )
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Relationship Rules */}
        {Object.keys(entityRules.relationships).length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-[var(--text-main)]">
                Relationship Rules
              </h3>
              <button
                onClick={() => {
                  setEditingRule({
                    category: "relationships",
                    entity: activeEntity,
                    ruleId: "",
                    rule: {},
                  });
                  setShowEditor(true);
                }}
                className="px-3 py-1.5 text-sm border border-[var(--border)] rounded-lg hover:bg-gray-50"
              >
                + Add Relationship Rule
              </button>
            </div>
            <div className="space-y-3">
              {Object.entries(entityRules.relationships).map(
                ([relKey, relRule]: [string, any]) => (
                  <RuleCard
                    key={relKey}
                    rule={relRule}
                    entity={activeEntity}
                    category="relationships"
                    ruleId={relKey}
                    onView={() =>
                      navigate(`/rules/relationships/${activeEntity}/${relKey}`)
                    }
                    onEdit={() =>
                      handleEditClick(
                        "relationships",
                        activeEntity,
                        relKey,
                        relRule
                      )
                    }
                    onDelete={() =>
                      handleDeleteClick("relationships", activeEntity, relKey)
                    }
                  />
                )
              )}
            </div>
          </div>
        )}

        {/* Required Field Rules */}
        {entityRules.required_fields?.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-[var(--text-main)]">
                Required Field Rules
              </h3>
              <button
                onClick={() => {
                  setEditingRule({
                    category: "required_fields",
                    entity: activeEntity,
                    ruleId: "",
                    rule: {},
                  });
                  setShowEditor(true);
                }}
                className="px-3 py-1.5 text-sm border border-[var(--border)] rounded-lg hover:bg-gray-50"
              >
                + Add Required Field
              </button>
            </div>
            <div className="space-y-3">
              {entityRules.required_fields.map(
                (fieldRule: any, idx: number) => {
                  // For required_fields, the rule_id might be missing, so use document ID or generate from field
                  // The document ID in Firestore is typically {entity}_{field}
                  const ruleId =
                    fieldRule.rule_id ||
                    (fieldRule.field
                      ? `${activeEntity}_${fieldRule.field}`
                      : undefined);

                  if (!ruleId) {
                    console.warn(
                      "Required field rule missing rule_id and field:",
                      fieldRule
                    );
                    return null;
                  }

                  return (
                    <RuleCard
                      key={idx}
                      rule={fieldRule}
                      entity={activeEntity}
                      category="required_fields"
                      ruleId={ruleId}
                      onView={() =>
                        navigate(
                          `/rules/required_fields/${activeEntity}/${ruleId}`
                        )
                      }
                      onEdit={() =>
                        handleEditClick(
                          "required_fields",
                          activeEntity,
                          ruleId,
                          fieldRule
                        )
                      }
                      onDelete={() =>
                        handleDeleteClick(
                          "required_fields",
                          activeEntity,
                          ruleId
                        )
                      }
                    />
                  );
                }
              )}
            </div>
          </div>
        )}
      </div>
    );
  };

  const entities = getEntitiesWithRules();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1
            className="text-3xl font-semibold text-[var(--text-main)] mb-2"
            style={{ fontFamily: "Outfit" }}
          >
            Rules Management
          </h1>
          <p className="text-[var(--text-muted)]">
            Configure data integrity rules by table
          </p>
        </div>
        <div className="flex gap-3">
          <button
            onClick={() => {
              setEditingRule({
                category: "duplicates",
                entity: activeEntity,
                ruleId: "",
                rule: {},
              });
              setShowEditor(true);
            }}
            className="px-4 py-2 border border-[var(--border)] rounded-lg hover:bg-gray-50"
          >
            + Create Rule Manually
          </button>
          <button
            onClick={() => setShowAICreator(true)}
            className="px-4 py-2 bg-[var(--cta-blue)] text-white rounded-lg hover:bg-blue-600"
          >
            + Create Rule with AI
          </button>
        </div>
      </div>

      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-800">
          {error}
        </div>
      )}

      {/* Entity/Table Tabs */}
      <div className="flex gap-2 border-b border-[var(--border)] overflow-x-auto">
        {entities.map((entity) => {
          const isHighlighted = highlightedEntity === entity;
          const isActive = activeEntity === entity;
          return (
            <button
              key={entity}
              ref={(el) => {
                entityTabRefs.current[entity] = el;
              }}
              onClick={() => setActiveEntity(entity)}
              className={`px-4 py-2 text-sm font-medium transition-all whitespace-nowrap ${
                isActive
                  ? "text-[var(--cta-blue)] border-b-2 border-[var(--cta-blue)]"
                  : "text-[var(--text-muted)] hover:text-[var(--text-main)]"
              } ${
                isHighlighted
                  ? "bg-[var(--cta-blue)]/10 ring-2 ring-[var(--cta-blue)] ring-offset-2 rounded-t-lg"
                  : ""
              }`}
            >
              {ENTITY_DISPLAY_NAMES[entity] || entity}
            </button>
          );
        })}
      </div>

      {/* Rules Content */}
      <div className="rounded-2xl border border-[var(--border)] bg-white p-6">
        {loading ? (
          <div className="text-center py-8 text-[var(--text-muted)]">
            Loading rules...
          </div>
        ) : entities.length === 0 ? (
          <div className="text-center py-12 text-[var(--text-muted)]">
            <p className="text-lg mb-2">No rules configured yet</p>
            <p className="text-sm">
              Create your first rule using the buttons above
            </p>
          </div>
        ) : (
          renderEntityRules()
        )}
      </div>

      {/* Modals */}
      <AIRuleCreator
        isOpen={showAICreator}
        onClose={() => setShowAICreator(false)}
        onRuleParsed={handleCreateRule}
        currentEntity={activeEntity}
      />

      {showEditor && editingRule && (
        <RuleEditor
          isOpen={showEditor}
          onClose={() => {
            setShowEditor(false);
            setEditingRule(null);
          }}
          onSave={handleSaveRule}
          category={editingRule.category}
          entity={editingRule.entity}
          initialRule={editingRule.rule}
          mode={editingRule.ruleId ? "edit" : "create"}
          currentEntity={activeEntity}
        />
      )}

      <ConfirmModal
        isOpen={deletingRule !== null}
        title="Delete Rule"
        message={`Are you sure you want to delete this rule? This action cannot be undone.`}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        isDestructive={true}
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeletingRule(null)}
      />
    </div>
  );
}

interface RuleCardProps {
  rule: Record<string, any>;
  category: string;
  entity?: string;
  ruleId?: string;
  onView: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

function RuleCard({
  rule,
  category,
  entity,
  ruleId,
  onView,
  onEdit,
  onDelete,
}: RuleCardProps) {
  return (
    <div className="p-4 border border-[var(--border)] rounded-lg hover:bg-gray-50 transition-colors">
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-2">
            <h4 className="font-medium text-[var(--text-main)]">
              {category === "required_fields" && rule.field_name
                ? formatRuleId(`required_field_rule.${entity}.${rule.field_name}`)
                : rule.rule_id
                ? formatRuleId(rule.rule_id)
                : ruleId
                ? formatRuleId(ruleId)
                : rule.field || "Rule"}
            </h4>
            {rule.severity && (
              <span
                className={`px-2 py-1 text-xs rounded ${
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
            {rule.enabled === false && (
              <span className="px-2 py-1 text-xs bg-gray-100 text-gray-600 rounded">
                Disabled
              </span>
            )}
          </div>
          <p className="text-sm text-[var(--text-muted)] mb-2">
            {rule.description ||
              rule.message ||
              JSON.stringify(rule, null, 2).substring(0, 100)}
          </p>
          {category === "relationships" && (
            <div className="text-xs text-[var(--text-muted)]">
              Target: {rule.target} | Min: {rule.min_links || 0} | Max:{" "}
              {rule.max_links || "∞"}
            </div>
          )}
          {category === "required_fields" && (
            <div className="text-xs text-[var(--text-muted)]">
              Field: {rule.field}
              {rule.condition_type && ` | Condition: ${rule.condition_type}`}
            </div>
          )}
        </div>
        <div className="flex gap-2 items-center">
          <button
            onClick={onView}
            className="p-2 text-[var(--cta-blue)] hover:bg-blue-50 rounded transition-colors"
            title="View Details"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="12" y1="16" x2="12" y2="12"></line>
              <line x1="12" y1="8" x2="12.01" y2="8"></line>
            </svg>
          </button>
          <button
            onClick={onEdit}
            className="p-2 text-gray-600 hover:bg-gray-100 rounded transition-colors"
            title="Edit Rule"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
            </svg>
          </button>
          <button
            onClick={onDelete}
            className="p-2 hover:bg-red-50 rounded transition-colors"
            title="Delete Rule"
          >
            <img
              src={trashIcon}
              alt="Delete"
              className="w-5 h-5"
              style={{
                filter:
                  "brightness(0) saturate(100%) invert(20%) sepia(100%) saturate(5000%) hue-rotate(350deg) brightness(90%) contrast(100%)",
              }}
            />
          </button>
        </div>
      </div>
    </div>
  );
}
