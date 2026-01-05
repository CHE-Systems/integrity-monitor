import React, { useState, useEffect } from "react";
import { useAuth } from "../hooks/useAuth";
import { useRules } from "../hooks/useRules";
import type { AirtableSchema, AirtableTable } from "../utils/airtable";
import {
  ACTIVE_ENTITIES,
  ENTITY_TABLE_MAPPING,
  TABLE_ENTITY_MAPPING,
} from "../config/entities";

export interface ScanConfig {
  checks: {
    duplicates: boolean;
    links: boolean;
    required_fields: boolean;
    attendance: boolean;
  };
  entities?: string[]; // Optional: selected entity names to scan
  rules?: {
    duplicates?: Record<string, string[]>;
    relationships?: Record<string, string[]>;
    required_fields?: Record<string, string[]>;
    attendance_rules?: boolean;
  };
  notify_slack?: boolean; // Optional: send Slack notification on completion
}

interface ScanConfigModalProps {
  isOpen: boolean;
  onConfirm: (config: ScanConfig) => void;
  onCancel: () => void;
}

import { API_BASE } from "../config/api";

export function ScanConfigModal({
  isOpen,
  onConfirm,
  onCancel,
}: ScanConfigModalProps) {
  const [checks, setChecks] = useState({
    duplicates: true,
    links: true,
    required_fields: true,
    attendance: true,
  });
  const [schema, setSchema] = useState<AirtableSchema | null>(null);
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [selectedEntities, setSelectedEntities] = useState<Set<string>>(
    new Set() // CRITICAL FIX: Start with NO entities selected - user must select manually
  );
  const [selectedRules, setSelectedRules] = useState<{
    duplicates?: Record<string, string[]>;
    relationships?: Record<string, string[]>;
    required_fields?: Record<string, string[]>;
    attendance_rules?: boolean;
  }>({});
  const [expandedTables, setExpandedTables] = useState<Set<string>>(
    new Set() // Start empty, expand as tables are selected
  );
  const { getToken, loading: authLoading, user: authUser } = useAuth();
  const { loadRules, loading: rulesLoading } = useRules();
  const [rules, setRules] = useState<any>(null);
  const [rulesError, setRulesError] = useState<string | null>(null);
  const [notifySlack, setNotifySlack] = useState(false);

  // Reset state when modal closes to ensure clean slate on next open
  useEffect(() => {
    if (!isOpen) {
      // Clear all selections when modal closes
      setSelectedEntities(new Set());
      setSelectedRules({});
      setRules(null);
      setRulesError(null);
      setSchema(null);
      setExpandedTables(new Set());
      setNotifySlack(false);
    }
  }, [isOpen]);

  // Load rules when modal opens (wait for auth to be ready)
  useEffect(() => {
    // Don't load if modal isn't open, auth is loading, or user isn't authenticated
    if (!isOpen || authLoading || !authUser) return;

    const loadRulesData = async () => {
      setRulesError(null);
      try {
        const rulesData = await loadRules();
        console.log("[ScanConfigModal] Loaded rules data:", rulesData);
        console.log("[ScanConfigModal] Rules structure:", {
          duplicates: rulesData?.duplicates
            ? Object.keys(rulesData.duplicates)
            : [],
          relationships: rulesData?.relationships
            ? Object.keys(rulesData.relationships)
            : [],
          required_fields: rulesData?.required_fields
            ? Object.keys(rulesData.required_fields)
            : [],
        });
        console.log(
          "[ScanConfigModal] Full rules structure for debugging:",
          JSON.stringify(rulesData, null, 2)
        );
        setRules(
          rulesData || {
            duplicates: {},
            relationships: {},
            required_fields: {},
            attendance_rules: {},
          }
        );
      } catch (error) {
        console.error("Failed to load rules:", error);
        const errorMessage =
          error instanceof Error ? error.message : "Failed to load rules";
        setRulesError(errorMessage);
        // Set empty rules structure so UI doesn't hang
        setRules({
          duplicates: {},
          relationships: {},
          required_fields: {},
          attendance_rules: {},
        });
      }
    };

    loadRulesData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, authLoading, authUser, loadRules]);

  // Fetch schema when modal opens - load from local JSON first for instant display
  useEffect(() => {
    if (!isOpen) return;

    const loadSchema = async () => {
      setSchemaLoading(true);
      try {
        // Try local schema first (instant, no network request)
        const localResponse = await fetch("/airtable-schema.json", {
          cache: "no-store",
        });
        if (localResponse.ok) {
          const localData = await localResponse.json();
          setSchema(localData);
          setSchemaLoading(false);
          // Optionally refresh from API in background (non-blocking)
          try {
            const token = await getToken();
            const apiResponse = await fetch(`${API_BASE}/airtable/schema`, {
              headers: token ? { Authorization: `Bearer ${token}` } : {},
            });
            if (apiResponse.ok) {
              const apiData = await apiResponse.json();
              setSchema(apiData); // Update with fresh data if available
            }
          } catch (apiError) {
            // Silently fail - we already have local schema
            console.debug("Failed to refresh schema from API:", apiError);
          }
        } else {
          // Fallback to API if local schema not available
          const token = await getToken();
          const response = await fetch(`${API_BASE}/airtable/schema`, {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
          });
          if (response.ok) {
            const data = await response.json();
            setSchema(data);
          }
          setSchemaLoading(false);
        }
      } catch (error) {
        console.error("Failed to load schema:", error);
        setSchemaLoading(false);
      }
    };

    loadSchema();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Map tables to entities
  const entityTableMap = React.useMemo(() => {
    if (!schema) return new Map<string, AirtableTable>();

    const map = new Map<string, AirtableTable>();
    for (const table of schema.tables || []) {
      const entity = TABLE_ENTITY_MAPPING[table.name];
      if (entity) {
        map.set(entity, table);
      }
    }
    return map;
  }, [schema]);

  // Get available entities (all active entities that exist in schema, regardless of rules)
  const availableEntities = React.useMemo(() => {
    const entitiesFromSchema = Array.from(entityTableMap.keys());

    // Show all active entities that exist in schema, regardless of rules
    // This ensures entities don't disappear when rules load and allows
    // users to see and select entities even before rules are created
    const activeEntitiesSet = new Set(ACTIVE_ENTITIES);
    return entitiesFromSchema
      .filter((entity) => activeEntitiesSet.has(entity))
      .sort();
  }, [entityTableMap]);

  // REMOVED: useEffect that auto-selected all entities when schema loaded
  // This was causing ALL tables to be auto-selected, leading to unintended scans
  // Users must now explicitly select tables and rules

  // Helper to find matching entity name in rules (handles singular/plural mismatches)
  const findEntityInRules = (
    category: "duplicates" | "relationships" | "required_fields",
    entityName: string
  ): string | null => {
    if (!rules || !rules[category]) return null;

    const availableEntities = Object.keys(rules[category]);

    // Try exact match first
    if (availableEntities.includes(entityName)) {
      return entityName;
    }

    // Try singular/plural variations
    const entityLower = entityName.toLowerCase();
    const matchingEntity = availableEntities.find((e) => {
      const eLower = e.toLowerCase();
      return (
        eLower === entityLower ||
        eLower === entityLower.slice(0, -1) || // entity is singular of entityName
        eLower === entityLower + "s" || // entity is plural of entityName
        entityLower === eLower + "s" || // entityName is plural of entity
        entityLower === eLower.slice(0, -1) // entityName is singular of entity
      );
    });

    return matchingEntity || null;
  };

  // Get all rule IDs for an entity in a category
  const getAllRuleIds = (
    category: "duplicates" | "relationships" | "required_fields",
    entityName: string
  ): string[] => {
    if (!rules) return [];

    // Find the actual entity name in the rules (handles name mismatches)
    const actualEntityName = findEntityInRules(category, entityName);
    if (!actualEntityName) {
      const availableEntities = rules[category]
        ? Object.keys(rules[category])
        : [];
      console.log(
        `[ScanConfigModal] No rules found for ${category}.${entityName}`,
        {
          category,
          entityName,
          availableEntities,
          rulesStructure: rules[category],
        }
      );
      return [];
    }

    if (actualEntityName !== entityName) {
      console.log(
        `[ScanConfigModal] Using entity name mapping: ${entityName} -> ${actualEntityName} for ${category}`
      );
    }

    const categoryRules = rules[category]?.[actualEntityName];
    if (!categoryRules) {
      return [];
    }

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

  // Check if all rules are selected for a check type across all entities
  const areAllRulesSelectedForCheckType = (
    checkType: "duplicates" | "links" | "required_fields" | "attendance"
  ): boolean => {
    if (checkType === "attendance") {
      return selectedRules.attendance_rules === true;
    }

    const category =
      checkType === "duplicates"
        ? "duplicates"
        : checkType === "links"
        ? "relationships"
        : "required_fields";

    if (selectedEntities.size === 0) return false;
    if (!rules) return false;

    // Check if all entities have all their rules selected
    const allSelected = Array.from(selectedEntities).every((entity) => {
      const allIds = getAllRuleIds(category, entity);
      if (allIds.length === 0) return true; // No rules means "all selected"
      const selectedIds = selectedRules[category]?.[entity] || [];
      return (
        selectedIds.length === allIds.length &&
        allIds.every((id) => selectedIds.includes(id))
      );
    });

    return allSelected;
  };

  // Check if any rules are selected for a check type (for indeterminate state)
  const areAnyRulesSelectedForCheckType = (
    checkType: "duplicates" | "links" | "required_fields" | "attendance"
  ): boolean => {
    if (checkType === "attendance") {
      return selectedRules.attendance_rules === true;
    }

    const category =
      checkType === "duplicates"
        ? "duplicates"
        : checkType === "links"
        ? "relationships"
        : "required_fields";

    if (selectedEntities.size === 0) return false;
    if (!rules) return false;

    // Check if any entity has any rules selected
    return Array.from(selectedEntities).some((entity) => {
      const selectedIds = selectedRules[category]?.[entity] || [];
      return selectedIds.length > 0;
    });
  };

  // Check if all rules are selected for a specific table and rule type
  const areAllRulesSelectedForTable = (
    entity: string,
    category: "duplicates" | "relationships" | "required_fields"
  ): boolean => {
    if (!rules) return false;
    const allIds = getAllRuleIds(category, entity);
    if (allIds.length === 0) return true; // No rules means "all selected"
    const selectedIds = selectedRules[category]?.[entity] || [];
    return (
      selectedIds.length === allIds.length &&
      allIds.every((id) => selectedIds.includes(id))
    );
  };

  // Check if any rules are selected for a specific table and rule type
  const areAnyRulesSelectedForTable = (
    entity: string,
    category: "duplicates" | "relationships" | "required_fields"
  ): boolean => {
    if (!rules) return false;
    const selectedIds = selectedRules[category]?.[entity] || [];
    return selectedIds.length > 0;
  };

  // Toggle all rules for a specific table and rule type
  const toggleTableRuleType = (
    entity: string,
    category: "duplicates" | "relationships" | "required_fields"
  ) => {
    const allSelected = areAllRulesSelectedForTable(entity, category);
    const allIds = getAllRuleIds(category, entity);

    if (allSelected) {
      // Deselect all
      handleRulesChange(category, entity, []);
    } else {
      // Select all
      handleRulesChange(category, entity, allIds);
    }
  };

  // Sync check type state with rule selection state
  useEffect(() => {
    if (!rules) return;

    setChecks((prev) => {
      const next = { ...prev };
      // Only update if we have entities selected, otherwise keep current state
      if (selectedEntities.size > 0) {
        next.duplicates = areAllRulesSelectedForCheckType("duplicates");
        next.links = areAllRulesSelectedForCheckType("links");
        next.required_fields =
          areAllRulesSelectedForCheckType("required_fields");
      }
      next.attendance = areAllRulesSelectedForCheckType("attendance");
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRules, selectedEntities.size, rules]);

  if (!isOpen) return null;

  const toggleCheckType = (checkName: keyof typeof checks) => {
    const allSelected = areAllRulesSelectedForCheckType(checkName);
    const newValue = !allSelected;

    // When toggling a check type, select/deselect all its rules
    if (newValue) {
      // Select all rules for this check type
      if (checkName === "duplicates") {
        selectedEntities.forEach((entity) => {
          const ruleIds = getAllRuleIds("duplicates", entity);
          if (ruleIds.length > 0) {
            handleRulesChange("duplicates", entity, ruleIds);
          }
        });
      } else if (checkName === "links") {
        selectedEntities.forEach((entity) => {
          const ruleIds = getAllRuleIds("relationships", entity);
          if (ruleIds.length > 0) {
            handleRulesChange("relationships", entity, ruleIds);
          }
        });
      } else if (checkName === "required_fields") {
        selectedEntities.forEach((entity) => {
          const ruleIds = getAllRuleIds("required_fields", entity);
          if (ruleIds.length > 0) {
            handleRulesChange("required_fields", entity, ruleIds);
          }
        });
      } else if (checkName === "attendance") {
        handleRulesChange("attendance_rules", "", true);
      }
      // Update check state to enabled
      setChecks((prev) => ({
        ...prev,
        [checkName]: true,
      }));
    } else {
      // Deselect all rules for this check type
      if (checkName === "duplicates") {
        selectedEntities.forEach((entity) => {
          handleRulesChange("duplicates", entity, []);
        });
      } else if (checkName === "links") {
        selectedEntities.forEach((entity) => {
          handleRulesChange("relationships", entity, []);
        });
      } else if (checkName === "required_fields") {
        selectedEntities.forEach((entity) => {
          handleRulesChange("required_fields", entity, []);
        });
      } else if (checkName === "attendance") {
        handleRulesChange("attendance_rules", "", false);
      }
      // Update check state to disabled
      setChecks((prev) => ({
        ...prev,
        [checkName]: false,
      }));
    }
  };

  const toggleTableExpansion = (entity: string) => {
    setExpandedTables((prev) => {
      const next = new Set(prev);
      if (next.has(entity)) {
        next.delete(entity);
      } else {
        next.add(entity);
      }
      return next;
    });
  };

  // Initialize rules for an entity (DO NOT auto-select - user must select manually)
  const initializeRulesForEntity = (entity: string) => {
    // CRITICAL FIX: Do NOT automatically select all rules when an entity is selected
    // The user must explicitly check the individual rules they want to run
    // Previously this was auto-selecting ALL rules, causing scans to run unselected rules

    // Just ensure the entity exists in selectedRules with empty arrays
    setSelectedRules((prev) => {
      const next = { ...prev };

      // Initialize with empty arrays so the UI works, but don't pre-select anything
      if (!next.duplicates) {
        next.duplicates = {};
      }
      if (!next.duplicates[entity]) {
        next.duplicates[entity] = [];
      }

      if (!next.relationships) {
        next.relationships = {};
      }
      if (!next.relationships[entity]) {
        next.relationships[entity] = [];
      }

      if (!next.required_fields) {
        next.required_fields = {};
      }
      if (!next.required_fields[entity]) {
        next.required_fields[entity] = [];
      }

      return next;
    });
  };

  // Remove rules for an entity
  const removeRulesForEntity = (entity: string) => {
    setSelectedRules((prev) => {
      const next = { ...prev };
      if (next.duplicates) {
        delete next.duplicates[entity];
      }
      if (next.relationships) {
        delete next.relationships[entity];
      }
      if (next.required_fields) {
        delete next.required_fields[entity];
      }
      return next;
    });
  };

  const handleEntityToggle = (entity: string) => {
    setSelectedEntities((prev) => {
      const next = new Set(prev);
      if (next.has(entity)) {
        next.delete(entity);
        removeRulesForEntity(entity);
        setExpandedTables((prevTables) => {
          const nextTables = new Set(prevTables);
          nextTables.delete(entity);
          return nextTables;
        });
      } else {
        next.add(entity);
        initializeRulesForEntity(entity);
        // Auto-expand when table is selected
        setExpandedTables((prevTables) => {
          const nextTables = new Set(prevTables);
          nextTables.add(entity);
          return nextTables;
        });
      }
      return next;
    });
  };

  const handleRulesChange = (
    category:
      | "duplicates"
      | "relationships"
      | "required_fields"
      | "attendance_rules",
    entity: string,
    ruleIds: string[] | boolean
  ) => {
    setSelectedRules((prev) => {
      const next = { ...prev };
      if (category === "attendance_rules") {
        next.attendance_rules = ruleIds as boolean;
      } else {
        if (!next[category]) {
          next[category] = {};
        }
        next[category]![entity] = ruleIds as string[];
      }
      return next;
    });
  };

  const handleSelectAllEntities = () => {
    if (selectedEntities.size === availableEntities.length) {
      setSelectedEntities(new Set());
    } else {
      setSelectedEntities(new Set(availableEntities));
    }
  };

  const handleSelectAllCheckTypes = () => {
    const allSelected =
      areAllRulesSelectedForCheckType("duplicates") &&
      areAllRulesSelectedForCheckType("links") &&
      areAllRulesSelectedForCheckType("required_fields") &&
      areAllRulesSelectedForCheckType("attendance");

    if (allSelected) {
      // Deselect all
      toggleCheckType("duplicates");
      toggleCheckType("links");
      toggleCheckType("required_fields");
      toggleCheckType("attendance");
    } else {
      // Select all
      if (!areAllRulesSelectedForCheckType("duplicates")) {
        toggleCheckType("duplicates");
      }
      if (!areAllRulesSelectedForCheckType("links")) {
        toggleCheckType("links");
      }
      if (!areAllRulesSelectedForCheckType("required_fields")) {
        toggleCheckType("required_fields");
      }
      if (!areAllRulesSelectedForCheckType("attendance")) {
        toggleCheckType("attendance");
      }
    }
  };

  const handleConfirm = () => {
    // CRITICAL FIX: Determine what runs based ONLY on selectedRules, not the checks state
    // This ensures scans only run the rules the user explicitly selected

    // DEBUG LOGGING: Show what's selected in the modal
    console.log("=".repeat(80));
    console.log("MODAL: User clicked Run Scan");
    console.log("=".repeat(80));
    console.log("Selected entities:", Array.from(selectedEntities));
    console.log("Selected rules:", JSON.stringify(selectedRules, null, 2));
    console.log("=".repeat(80));

    // Check if we have any duplicate rules selected (any entity with rules)
    const hasDuplicateRules = Boolean(
      selectedRules.duplicates &&
        Object.values(selectedRules.duplicates).some(
          (ruleIds) => ruleIds.length > 0
        )
    );

    // Check if we have any relationship rules selected
    const hasRelationshipRules = Boolean(
      selectedRules.relationships &&
        Object.values(selectedRules.relationships).some(
          (ruleIds) => ruleIds.length > 0
        )
    );

    // Check if we have any required field rules selected
    const hasRequiredFieldRules = Boolean(
      selectedRules.required_fields &&
        Object.values(selectedRules.required_fields).some(
          (ruleIds) => ruleIds.length > 0
        )
    );

    // Check if attendance rules are selected
    const hasAttendanceRules = selectedRules.attendance_rules === true;

    // Build effectiveChecks based ONLY on what rules are actually selected
    const effectiveChecks = {
      duplicates: hasDuplicateRules,
      links: hasRelationshipRules,
      required_fields: hasRequiredFieldRules,
      attendance: hasAttendanceRules,
    };

    // Only include rules if at least one category has selections
    const hasRules =
      hasDuplicateRules ||
      hasRelationshipRules ||
      hasRequiredFieldRules ||
      hasAttendanceRules;

    const configToSend = {
      checks: effectiveChecks,
      entities:
        selectedEntities.size > 0 ? Array.from(selectedEntities) : undefined,
      rules: hasRules ? selectedRules : undefined,
      notify_slack: notifySlack,
    };

    console.log(
      "MODAL: Config being sent to onConfirm:",
      JSON.stringify(configToSend, null, 2)
    );
    console.log("=".repeat(80));

    onConfirm(configToSend);
  };

  // Check if at least one rule is selected (not all rules, just at least one)
  const hasAtLeastOneCheck = (() => {
    if (selectedRules.attendance_rules === true) return true;

    // Check if any entity has any rules selected for any category
    if (selectedRules.duplicates) {
      for (const entity in selectedRules.duplicates) {
        if (selectedRules.duplicates[entity].length > 0) return true;
      }
    }
    if (selectedRules.relationships) {
      for (const entity in selectedRules.relationships) {
        if (selectedRules.relationships[entity].length > 0) return true;
      }
    }
    if (selectedRules.required_fields) {
      for (const entity in selectedRules.required_fields) {
        if (selectedRules.required_fields[entity].length > 0) return true;
      }
    }
    return false;
  })();
  const hasAtLeastOneEntity = selectedEntities.size > 0;

  // Count total number of selected rules
  const totalRuleCount = (() => {
    let count = 0;

    // Count attendance rules (1 if enabled, 0 if not)
    if (selectedRules.attendance_rules === true) {
      count += 1;
    }

    // Count duplicate rules
    if (selectedRules.duplicates) {
      for (const entity in selectedRules.duplicates) {
        count += selectedRules.duplicates[entity].length;
      }
    }

    // Count relationship rules
    if (selectedRules.relationships) {
      for (const entity in selectedRules.relationships) {
        count += selectedRules.relationships[entity].length;
      }
    }

    // Count required field rules
    if (selectedRules.required_fields) {
      for (const entity in selectedRules.required_fields) {
        count += selectedRules.required_fields[entity].length;
      }
    }

    return count;
  })();

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-0">
      <div
        className="fixed inset-0 bg-neutral-900/50 backdrop-blur-sm transition-opacity"
        onClick={onCancel}
        aria-hidden="true"
      />

      <div className="relative bg-white border border-[var(--border)] rounded-xl shadow-xl w-full max-w-5xl max-h-[90vh] overflow-y-auto transform transition-all p-6">
        <h3
          className="text-xl font-semibold text-[var(--text-main)] mb-4"
          style={{ fontFamily: "Outfit" }}
        >
          Configure Scan
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Left Column - Table/Entity Selection */}
          <div>
            {/* Table/Entity Selection */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <label className="block text-sm font-medium text-[var(--text-main)]">
                  Select Tables ({selectedEntities.size} of{" "}
                  {availableEntities.length})
                </label>
                {availableEntities.length > 0 && (
                  <button
                    onClick={handleSelectAllEntities}
                    className="text-sm text-[var(--brand)] hover:underline"
                    type="button"
                  >
                    {selectedEntities.size === availableEntities.length
                      ? "Deselect All"
                      : "Select All"}
                  </button>
                )}
              </div>
              {schemaLoading ? (
                <div className="text-sm text-[var(--text-muted)] py-4 text-center">
                  Loading tables...
                </div>
              ) : availableEntities.length === 0 ? (
                <div className="text-sm text-[var(--text-muted)] py-4 text-center">
                  No tables found. Please check your schema configuration.
                </div>
              ) : (
                <div className="max-h-[600px] overflow-y-auto space-y-2 border border-[var(--border)] rounded-lg p-3">
                  {availableEntities.map((entity) => {
                    const table = entityTableMap.get(entity);
                    return (
                      <label
                        key={entity}
                        className="flex items-center gap-3 p-2 rounded-lg hover:bg-[var(--bg-mid)]/50 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={selectedEntities.has(entity)}
                          onChange={() => handleEntityToggle(entity)}
                          className="w-4 h-4"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-sm text-[var(--text-main)]">
                            {ENTITY_TABLE_MAPPING[entity] || entity}
                          </div>
                          <div className="text-xs text-[var(--text-muted)]">
                            {entity} • {table?.recordCount ?? 0} records •{" "}
                            {table?.fieldCount ?? 0} fields
                          </div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              )}
              {!hasAtLeastOneEntity && (
                <p className="mt-2 text-sm text-red-600">
                  Please select at least one table
                </p>
              )}
            </div>
          </div>

          {/* Right Column - Tables with Nested Rules */}
          <div className="space-y-6">
            <div>
              <div className="flex items-center justify-between mb-3">
                <label className="block text-sm font-medium text-[var(--text-main)]">
                  Rules by Table
                </label>
                {selectedEntities.size > 0 && rules && (
                  <button
                    onClick={handleSelectAllCheckTypes}
                    className="text-sm text-[var(--brand)] hover:underline"
                    type="button"
                  >
                    {areAllRulesSelectedForCheckType("duplicates") &&
                    areAllRulesSelectedForCheckType("links") &&
                    areAllRulesSelectedForCheckType("required_fields") &&
                    areAllRulesSelectedForCheckType("attendance")
                      ? "Deselect All"
                      : "Select All"}
                  </button>
                )}
              </div>
              {selectedEntities.size === 0 ? (
                <div className="text-sm text-[var(--text-muted)] py-8 text-center border border-[var(--border)] rounded-lg">
                  Please select a table to see available rules
                </div>
              ) : rulesError ? (
                <div className="text-sm text-red-600 py-8 px-4 border border-red-300 rounded-lg bg-red-50">
                  <div className="font-medium mb-2">Failed to load rules</div>
                  <div className="text-xs space-y-1 text-left">
                    {rulesError.split('\n').map((line, index) => (
                      <div key={index} className={line.trim().startsWith('Current') || line.trim().startsWith('VITE') || line.trim().startsWith('To fix') ? 'font-mono text-[10px] text-gray-700' : ''}>
                        {line || '\u00A0'}
                      </div>
                    ))}
                  </div>
                </div>
              ) : rulesLoading || !rules ? (
                <div className="text-sm text-[var(--text-muted)] py-8 text-center border border-[var(--border)] rounded-lg">
                  Loading rules...
                </div>
              ) : (
                <div className="space-y-4 max-h-[600px] overflow-y-auto">
                  {Array.from(selectedEntities).map((entity) => {
                    const table = entityTableMap.get(entity);
                    const isExpanded = expandedTables.has(entity);

                    return (
                      <div
                        key={entity}
                        className="border border-[var(--border)] rounded-lg"
                      >
                        {/* Table Header */}
                        <div className="flex items-center p-3 hover:bg-[var(--bg-mid)]/50 transition-colors">
                          <button
                            type="button"
                            onClick={() => toggleTableExpansion(entity)}
                            className="mr-2 px-2 py-1 text-sm font-medium text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--bg-mid)]/30 rounded transition-colors"
                            aria-label={
                              isExpanded ? "Collapse table" : "Expand table"
                            }
                          >
                            {isExpanded ? "▼" : "▶"}
                          </button>
                          <div className="flex-1">
                            <div className="font-medium text-[var(--text-main)]">
                              {ENTITY_TABLE_MAPPING[entity] || entity}
                            </div>
                            <div className="text-xs text-[var(--text-muted)]">
                              {table?.recordCount ?? 0} records •{" "}
                              {table?.fieldCount ?? 0} fields
                            </div>
                          </div>
                        </div>

                        {isExpanded && (
                          <div className="px-3 pb-3 pt-2 space-y-4 border-t border-[var(--border)] bg-[var(--bg-mid)]/20">
                            {/* Duplicate Detection Rules */}
                            {(() => {
                              const actualEntityName = findEntityInRules(
                                "duplicates",
                                entity
                              );
                              if (!actualEntityName) return null;

                              const dupDef = rules.duplicates?.[
                                actualEntityName
                              ] as
                                | { likely?: any[]; possible?: any[] }
                                | undefined;

                              if (!dupDef) return null;

                              const likelyRules = dupDef.likely || [];
                              const possibleRules = dupDef.possible || [];
                              const allRuleIds = getAllRuleIds(
                                "duplicates",
                                entity
                              );
                              const selectedIds =
                                selectedRules.duplicates?.[entity] || [];

                              if (allRuleIds.length === 0) return null;

                              return (
                                <div className="space-y-2">
                                  <div className="flex items-center justify-between">
                                    <div className="text-sm font-medium text-[var(--text-main)]">
                                      Duplicate Detection
                                    </div>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        toggleTableRuleType(
                                          entity,
                                          "duplicates"
                                        )
                                      }
                                      className="text-xs text-[var(--brand)] hover:underline"
                                    >
                                      {areAllRulesSelectedForTable(
                                        entity,
                                        "duplicates"
                                      )
                                        ? "Deselect All"
                                        : "Select All"}
                                    </button>
                                  </div>
                                  {likelyRules.length > 0 && (
                                    <div className="ml-2 space-y-1">
                                      <div className="text-xs font-medium text-[var(--text-muted)] mb-1.5">
                                        Likely
                                      </div>
                                      {likelyRules.map((rule: any) => (
                                        <label
                                          key={rule.rule_id}
                                          className="flex items-center gap-2 p-2 rounded-md hover:bg-[var(--bg-mid)]/40 cursor-pointer transition-colors"
                                        >
                                          <input
                                            type="checkbox"
                                            checked={selectedIds.includes(
                                              rule.rule_id
                                            )}
                                            onChange={() =>
                                              handleRulesChange(
                                                "duplicates",
                                                entity,
                                                selectedIds.includes(
                                                  rule.rule_id
                                                )
                                                  ? selectedIds.filter(
                                                      (id) =>
                                                        id !== rule.rule_id
                                                    )
                                                  : [
                                                      ...selectedIds,
                                                      rule.rule_id,
                                                    ]
                                              )
                                            }
                                            className="w-3.5 h-3.5"
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
                                    <div className="ml-2 mt-3 space-y-1">
                                      <div className="text-xs font-medium text-[var(--text-muted)] mb-1.5">
                                        Possible
                                      </div>
                                      {possibleRules.map((rule: any) => (
                                        <label
                                          key={rule.rule_id}
                                          className="flex items-center gap-2 p-2 rounded-md hover:bg-[var(--bg-mid)]/40 cursor-pointer transition-colors"
                                        >
                                          <input
                                            type="checkbox"
                                            checked={selectedIds.includes(
                                              rule.rule_id
                                            )}
                                            onChange={() =>
                                              handleRulesChange(
                                                "duplicates",
                                                entity,
                                                selectedIds.includes(
                                                  rule.rule_id
                                                )
                                                  ? selectedIds.filter(
                                                      (id) =>
                                                        id !== rule.rule_id
                                                    )
                                                  : [
                                                      ...selectedIds,
                                                      rule.rule_id,
                                                    ]
                                              )
                                            }
                                            className="w-3.5 h-3.5"
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
                            })()}

                            {/* Relationship Rules */}
                            {(() => {
                              const actualEntityName = findEntityInRules(
                                "relationships",
                                entity
                              );
                              if (!actualEntityName) return null;

                              const relRules =
                                rules.relationships?.[actualEntityName];

                              if (
                                !relRules ||
                                Object.keys(relRules).length === 0
                              )
                                return null;

                              const selectedIds =
                                selectedRules.relationships?.[entity] || [];

                              return (
                                <div className="space-y-2">
                                  <div className="flex items-center justify-between">
                                    <div className="text-sm font-medium text-[var(--text-main)]">
                                      Relationship Rules
                                    </div>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        toggleTableRuleType(
                                          entity,
                                          "relationships"
                                        )
                                      }
                                      className="text-xs text-[var(--brand)] hover:underline"
                                    >
                                      {areAllRulesSelectedForTable(
                                        entity,
                                        "relationships"
                                      )
                                        ? "Deselect All"
                                        : "Select All"}
                                    </button>
                                  </div>
                                  <div className="ml-2 space-y-1">
                                    {Object.entries(relRules).map(
                                      ([relKey, relRule]: [string, any]) => (
                                        <label
                                          key={relKey}
                                          className="flex items-center gap-2 p-2 rounded-md hover:bg-[var(--bg-mid)]/40 cursor-pointer transition-colors"
                                        >
                                          <input
                                            type="checkbox"
                                            checked={selectedIds.includes(
                                              relKey
                                            )}
                                            onChange={() =>
                                              handleRulesChange(
                                                "relationships",
                                                entity,
                                                selectedIds.includes(relKey)
                                                  ? selectedIds.filter(
                                                      (id) => id !== relKey
                                                    )
                                                  : [...selectedIds, relKey]
                                              )
                                            }
                                            className="w-3.5 h-3.5"
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
                                      )
                                    )}
                                  </div>
                                </div>
                              );
                            })()}

                            {/* Required Field Rules */}
                            {(() => {
                              const actualEntityName = findEntityInRules(
                                "required_fields",
                                entity
                              );
                              if (!actualEntityName) return null;

                              const reqFields =
                                rules.required_fields?.[actualEntityName];

                              if (
                                !reqFields ||
                                !Array.isArray(reqFields) ||
                                reqFields.length === 0
                              )
                                return null;

                              const selectedIds =
                                selectedRules.required_fields?.[entity] || [];

                              return (
                                <div className="space-y-2">
                                  <div className="flex items-center justify-between">
                                    <div className="text-sm font-medium text-[var(--text-main)]">
                                      Required Field Rules
                                    </div>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        toggleTableRuleType(
                                          entity,
                                          "required_fields"
                                        )
                                      }
                                      className="text-xs text-[var(--brand)] hover:underline"
                                    >
                                      {areAllRulesSelectedForTable(
                                        entity,
                                        "required_fields"
                                      )
                                        ? "Deselect All"
                                        : "Select All"}
                                    </button>
                                  </div>
                                  <div className="ml-2 space-y-1">
                                    {reqFields.map((field: any) => {
                                      const ruleId =
                                        field.rule_id ||
                                        field.field ||
                                        `required.${entity}.${field.field}`;
                                      return (
                                        <label
                                          key={ruleId}
                                          className="flex items-center gap-2 p-2 rounded-md hover:bg-[var(--bg-mid)]/40 cursor-pointer transition-colors"
                                        >
                                          <input
                                            type="checkbox"
                                            checked={selectedIds.includes(
                                              ruleId
                                            )}
                                            onChange={() =>
                                              handleRulesChange(
                                                "required_fields",
                                                entity,
                                                selectedIds.includes(ruleId)
                                                  ? selectedIds.filter(
                                                      (id) => id !== ruleId
                                                    )
                                                  : [...selectedIds, ruleId]
                                              )
                                            }
                                            className="w-3.5 h-3.5"
                                          />
                                          <div className="flex-1 min-w-0">
                                            <div className="text-xs font-medium text-[var(--text-main)]">
                                              {field.field || ruleId}
                                            </div>
                                            <div className="text-xs text-[var(--text-muted)] truncate">
                                              {field.message || ""}
                                            </div>
                                          </div>
                                        </label>
                                      );
                                    })}
                                  </div>
                                </div>
                              );
                            })()}

                            {/* Attendance Rules (for attendance and absent tables) */}
                            {(entity === "attendance" || entity === "absent") &&
                              (selectedEntities.has("attendance") ||
                                selectedEntities.has("absent")) && (
                                <div className="space-y-2">
                                  <div className="text-sm font-medium text-[var(--text-main)]">
                                    Attendance Rules
                                  </div>
                                  {entity === "attendance" && (
                                    <label className="flex items-center gap-2 p-2 rounded-md hover:bg-[var(--bg-mid)]/40 cursor-pointer transition-colors">
                                      <input
                                        type="checkbox"
                                        checked={
                                          selectedRules.attendance_rules ??
                                          false
                                        }
                                        onChange={(e) =>
                                          handleRulesChange(
                                            "attendance_rules",
                                            "",
                                            e.target.checked
                                          )
                                        }
                                        className="w-3.5 h-3.5"
                                      />
                                      <span className="text-xs font-medium text-[var(--text-main)]">
                                        Attendance Anomalies
                                      </span>
                                    </label>
                                  )}
                                  {entity === "absent" && (
                                    <label className="flex items-center gap-2 p-2 rounded-md hover:bg-[var(--bg-mid)]/40 cursor-pointer transition-colors">
                                      <input
                                        type="checkbox"
                                        checked={
                                          selectedRules.attendance_rules ??
                                          false
                                        }
                                        onChange={(e) =>
                                          handleRulesChange(
                                            "attendance_rules",
                                            "",
                                            e.target.checked
                                          )
                                        }
                                        className="w-3.5 h-3.5"
                                      />
                                      <span className="text-xs font-medium text-[var(--text-main)]">
                                        Duplicate Absence Detection
                                      </span>
                                    </label>
                                  )}
                                </div>
                              )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              {selectedEntities.size > 0 && rules && !hasAtLeastOneCheck && (
                <p className="mt-2 text-sm text-red-600">
                  Please select at least one rule
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Rule Count */}
        <div className="mt-6 pt-4 border-t border-[var(--border)]">
          <div className="text-sm text-[var(--text-muted)] text-center">
            {totalRuleCount === 0 ? (
              "No rules selected"
            ) : (
              <>
                <span className="font-medium text-[var(--text-main)]">
                  {totalRuleCount}
                </span>{" "}
                {totalRuleCount === 1 ? "rule" : "rules"} will be used for this
                scan
              </>
            )}
          </div>
        </div>

        {/* Slack Notification Toggle */}
        <div className="mt-4 flex items-center justify-center">
          <label className="flex items-center gap-2 cursor-pointer p-2 rounded-lg hover:bg-[var(--bg-mid)]/50">
            <input
              type="checkbox"
              checked={notifySlack}
              onChange={(e) => setNotifySlack(e.target.checked)}
              className="w-4 h-4"
            />
            <span className="text-sm text-[var(--text-main)]">
              Send Slack notification when scan completes with issues
            </span>
          </label>
        </div>

        {/* Action Buttons */}
        <div className="flex justify-end space-x-3 mt-6">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm font-medium text-[var(--text-muted)] hover:text-[var(--text-main)] bg-[var(--bg-mid)]/50 hover:bg-[var(--bg-mid)] rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={!hasAtLeastOneCheck || !hasAtLeastOneEntity}
            className="px-4 py-2 text-sm font-medium text-white rounded-lg transition-colors shadow-sm bg-[var(--brand)] hover:bg-[var(--brand)]/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Run Scan
          </button>
        </div>
      </div>
    </div>
  );
}
