import React, { useState, useMemo } from "react";
import type { RulesByCategory } from "../hooks/useRules";

interface RuleSelectionPanelProps {
  entity: string;
  rules: RulesByCategory;
  selectedRules: {
    duplicates?: Record<string, string[]>;
    relationships?: Record<string, string[]>;
    required_fields?: Record<string, string[]>;
    attendance_rules?: boolean;
  };
  onRulesChange: (
    category:
      | "duplicates"
      | "relationships"
      | "required_fields"
      | "attendance_rules",
    entity: string,
    ruleIds: string[] | boolean
  ) => void;
  entityDisplayName?: string;
}

export function RuleSelectionPanel({
  entity,
  rules,
  selectedRules,
  onRulesChange,
  entityDisplayName,
}: RuleSelectionPanelProps) {
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(
    new Set(["duplicates", "relationships", "required_fields"])
  );

  const toggleCategory = (category: string) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  };

  // Get all rule IDs for an entity in a category
  const getAllRuleIds = (
    category: "duplicates" | "relationships" | "required_fields",
    entityName: string
  ): string[] => {
    const categoryRules = rules[category]?.[entityName];
    if (!categoryRules) return [];

    if (category === "duplicates") {
      const dupDef = categoryRules as { likely?: any[]; possible?: any[] };
      const likelyIds = (dupDef.likely || []).map((r: any) => r.rule_id);
      const possibleIds = (dupDef.possible || []).map((r: any) => r.rule_id);
      return [...likelyIds, ...possibleIds];
    } else if (category === "relationships") {
      return Object.keys(categoryRules);
    } else if (category === "required_fields") {
      return (categoryRules as any[]).map(
        (r: any) => r.rule_id || r.field || `required.${entityName}.${r.field}`
      );
    }
    return [];
  };

  // Get selected rule IDs for an entity in a category
  const getSelectedRuleIds = (
    category: "duplicates" | "relationships" | "required_fields",
    entityName: string
  ): string[] => {
    return selectedRules[category]?.[entityName] || [];
  };

  // Check if all rules are selected for a category
  const areAllRulesSelected = (
    category: "duplicates" | "relationships" | "required_fields",
    entityName: string
  ): boolean => {
    const allIds = getAllRuleIds(category, entityName);
    const selectedIds = getSelectedRuleIds(category, entityName);
    return (
      allIds.length > 0 &&
      allIds.length === selectedIds.length &&
      allIds.every((id) => selectedIds.includes(id))
    );
  };

  // Toggle all rules for a category
  const toggleAllRules = (
    category: "duplicates" | "relationships" | "required_fields",
    entityName: string
  ) => {
    const allIds = getAllRuleIds(category, entityName);
    if (areAllRulesSelected(category, entityName)) {
      onRulesChange(category, entityName, []);
    } else {
      onRulesChange(category, entityName, allIds);
    }
  };

  // Toggle individual rule
  const toggleRule = (
    category: "duplicates" | "relationships" | "required_fields",
    entityName: string,
    ruleId: string
  ) => {
    const selectedIds = getSelectedRuleIds(category, entityName);
    const newSelectedIds = selectedIds.includes(ruleId)
      ? selectedIds.filter((id) => id !== ruleId)
      : [...selectedIds, ruleId];
    onRulesChange(category, entityName, newSelectedIds);
  };

  // Render duplicates rules
  const renderDuplicates = () => {
    const dupDef = rules.duplicates?.[entity] as
      | { likely?: any[]; possible?: any[] }
      | undefined;
    if (!dupDef) return null;

    const likelyRules = dupDef.likely || [];
    const possibleRules = dupDef.possible || [];
    const allRuleIds = getAllRuleIds("duplicates", entity);
    const selectedIds = getSelectedRuleIds("duplicates", entity);

    if (allRuleIds.length === 0) return null;

    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-[var(--text-main)]">
            Duplicates
          </span>
          <button
            type="button"
            onClick={() => toggleAllRules("duplicates", entity)}
            className="text-xs text-[var(--brand)] hover:underline"
          >
            {areAllRulesSelected("duplicates", entity)
              ? "Deselect All"
              : "Select All"}
          </button>
        </div>
        <div className="text-xs text-[var(--text-muted)] mb-2">
          {selectedIds.length} of {allRuleIds.length} selected
        </div>
        {likelyRules.length > 0 && (
          <div className="ml-2">
            <div className="text-xs font-medium text-[var(--text-muted)] mb-1">
              Likely
            </div>
            {likelyRules.map((rule: any) => (
              <label
                key={rule.rule_id}
                className="flex items-center gap-2 p-2 rounded hover:bg-[var(--bg-mid)]/50 cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={selectedIds.includes(rule.rule_id)}
                  onChange={() =>
                    toggleRule("duplicates", entity, rule.rule_id)
                  }
                  className="w-4 h-4"
                />
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium text-[var(--text-main)]">
                    {rule.rule_id}
                  </div>
                  <div className="text-xs text-[var(--text-muted)] truncate">
                    {rule.description || ""}
                  </div>
                </div>
              </label>
            ))}
          </div>
        )}
        {possibleRules.length > 0 && (
          <div className="ml-2 mt-2">
            <div className="text-xs font-medium text-[var(--text-muted)] mb-1">
              Possible
            </div>
            {possibleRules.map((rule: any) => (
              <label
                key={rule.rule_id}
                className="flex items-center gap-2 p-2 rounded hover:bg-[var(--bg-mid)]/50 cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={selectedIds.includes(rule.rule_id)}
                  onChange={() =>
                    toggleRule("duplicates", entity, rule.rule_id)
                  }
                  className="w-4 h-4"
                />
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium text-[var(--text-main)]">
                    {rule.rule_id}
                  </div>
                  <div className="text-xs text-[var(--text-muted)] truncate">
                    {rule.description || ""}
                  </div>
                </div>
              </label>
            ))}
          </div>
        )}
      </div>
    );
  };

  // Render relationships rules
  const renderRelationships = () => {
    const relRules = rules.relationships?.[entity];
    if (!relRules || Object.keys(relRules).length === 0) return null;

    const allRuleIds = getAllRuleIds("relationships", entity);
    const selectedIds = getSelectedRuleIds("relationships", entity);

    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-[var(--text-main)]">
            Relationships
          </span>
          <button
            type="button"
            onClick={() => toggleAllRules("relationships", entity)}
            className="text-xs text-[var(--brand)] hover:underline"
          >
            {areAllRulesSelected("relationships", entity)
              ? "Deselect All"
              : "Select All"}
          </button>
        </div>
        <div className="text-xs text-[var(--text-muted)] mb-2">
          {selectedIds.length} of {allRuleIds.length} selected
        </div>
        {Object.entries(relRules).map(([relKey, relRule]: [string, any]) => {
          const ruleId = `link.${entity}.${relKey}`;
          return (
            <label
              key={relKey}
              className="flex items-center gap-2 p-2 rounded hover:bg-[var(--bg-mid)]/50 cursor-pointer"
            >
              <input
                type="checkbox"
                checked={selectedIds.includes(relKey)}
                onChange={() => toggleRule("relationships", entity, relKey)}
                className="w-4 h-4"
              />
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium text-[var(--text-main)]">
                  {relKey}
                </div>
                <div className="text-xs text-[var(--text-muted)] truncate">
                  {relRule.message || ""}
                </div>
              </div>
            </label>
          );
        })}
      </div>
    );
  };

  // Render required fields rules
  const renderRequiredFields = () => {
    const reqFields = rules.required_fields?.[entity];
    if (!reqFields || !Array.isArray(reqFields) || reqFields.length === 0)
      return null;

    const allRuleIds = getAllRuleIds("required_fields", entity);
    const selectedIds = getSelectedRuleIds("required_fields", entity);

    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-[var(--text-main)]">
            Required Fields
          </span>
          <button
            type="button"
            onClick={() => toggleAllRules("required_fields", entity)}
            className="text-xs text-[var(--brand)] hover:underline"
          >
            {areAllRulesSelected("required_fields", entity)
              ? "Deselect All"
              : "Select All"}
          </button>
        </div>
        <div className="text-xs text-[var(--text-muted)] mb-2">
          {selectedIds.length} of {allRuleIds.length} selected
        </div>
        {reqFields.map((field: any) => {
          const ruleId =
            field.rule_id || field.field || `required.${entity}.${field.field}`;
          return (
            <label
              key={ruleId}
              className="flex items-center gap-2 p-2 rounded hover:bg-[var(--bg-mid)]/50 cursor-pointer"
            >
              <input
                type="checkbox"
                checked={selectedIds.includes(ruleId)}
                onChange={() => toggleRule("required_fields", entity, ruleId)}
                className="w-4 h-4"
              />
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium text-[var(--text-main)]">
                  {field.field_name || field.field || ruleId}
                </div>
                <div className="text-xs text-[var(--text-muted)] truncate">
                  {field.message || ""}
                </div>
              </div>
            </label>
          );
        })}
      </div>
    );
  };

  const hasAnyRules =
    (rules.duplicates?.[entity] &&
      getAllRuleIds("duplicates", entity).length > 0) ||
    (rules.relationships?.[entity] &&
      Object.keys(rules.relationships[entity]).length > 0) ||
    (rules.required_fields?.[entity] &&
      Array.isArray(rules.required_fields[entity]) &&
      rules.required_fields[entity].length > 0);

  if (!hasAnyRules) {
    return (
      <div className="text-xs text-[var(--text-muted)] p-2">
        No rules configured for {entityDisplayName || entity}
      </div>
    );
  }

  return (
    <div className="space-y-4 border border-[var(--border)] rounded-lg p-3 bg-[var(--bg-mid)]/30">
      <div className="font-medium text-sm text-[var(--text-main)]">
        {entityDisplayName || entity}
      </div>

      <div>
        <button
          type="button"
          onClick={() => toggleCategory("duplicates")}
          className="flex items-center justify-between w-full text-left mb-2"
        >
          <span className="text-sm font-medium text-[var(--text-main)]">
            Duplicates
          </span>
          <span className="text-xs">
            {expandedCategories.has("duplicates") ? "▼" : "▶"}
          </span>
        </button>
        {expandedCategories.has("duplicates") && renderDuplicates()}
      </div>

      <div>
        <button
          type="button"
          onClick={() => toggleCategory("relationships")}
          className="flex items-center justify-between w-full text-left mb-2"
        >
          <span className="text-sm font-medium text-[var(--text-main)]">
            Relationships
          </span>
          <span className="text-xs">
            {expandedCategories.has("relationships") ? "▼" : "▶"}
          </span>
        </button>
        {expandedCategories.has("relationships") && renderRelationships()}
      </div>

      <div>
        <button
          type="button"
          onClick={() => toggleCategory("required_fields")}
          className="flex items-center justify-between w-full text-left mb-2"
        >
          <span className="text-sm font-medium text-[var(--text-main)]">
            Required Fields
          </span>
          <span className="text-xs">
            {expandedCategories.has("required_fields") ? "▼" : "▶"}
          </span>
        </button>
        {expandedCategories.has("required_fields") && renderRequiredFields()}
      </div>
    </div>
  );
}
