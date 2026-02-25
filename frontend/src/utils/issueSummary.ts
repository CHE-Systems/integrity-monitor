/**
 * Utilities for building compact issue summaries to send as AI chat context.
 */

import type { Issue } from "../hooks/useFirestoreIssues";

interface RuleSummary {
  count: number;
  entity: string;
  severity: string;
  sample_descriptions: string[];
}

interface IssueSummary {
  total_issues: number;
  by_entity: Record<string, number>;
  by_type: Record<string, number>;
  by_severity: Record<string, number>;
  by_rule: Record<string, RuleSummary>;
  by_status: Record<string, number>;
  metadata_summary: {
    missing_field_names: Record<string, number>;
    duplicate_related_counts: Record<string, number>;
    target_entities: Record<string, number>;
  };
}

/**
 * Build a compact JSON summary of issues for the AI chat context.
 * Designed to be small (~2-3KB) even for 500+ issues.
 */
export function buildIssueSummary(issues: Issue[]): string {
  const byEntity: Record<string, number> = {};
  const byType: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  const byRule: Record<string, RuleSummary> = {};
  const byStatus: Record<string, number> = {};

  // Metadata aggregations
  const missingFieldNames: Record<string, number> = {};
  const duplicateRelatedCounts: Record<string, number> = {};
  const targetEntities: Record<string, number> = {};

  for (const issue of issues) {
    // Count by entity
    byEntity[issue.entity] = (byEntity[issue.entity] || 0) + 1;

    // Count by type
    byType[issue.issue_type] = (byType[issue.issue_type] || 0) + 1;

    // Count by severity
    bySeverity[issue.severity] = (bySeverity[issue.severity] || 0) + 1;

    // Count by status
    const status = issue.status || "open";
    byStatus[status] = (byStatus[status] || 0) + 1;

    // Count by rule with sample descriptions
    const ruleId = issue.rule_id || "unknown";
    if (!byRule[ruleId]) {
      byRule[ruleId] = {
        count: 0,
        entity: issue.entity,
        severity: issue.severity,
        sample_descriptions: [],
      };
    }
    byRule[ruleId].count++;
    if (
      byRule[ruleId].sample_descriptions.length < 5 &&
      issue.description &&
      !byRule[ruleId].sample_descriptions.includes(issue.description)
    ) {
      byRule[ruleId].sample_descriptions.push(issue.description);
    }

    // Metadata aggregations
    const metadata = issue.metadata || {};

    if (issue.issue_type === "missing_field" && metadata.field_name) {
      const fieldName = String(metadata.field_name);
      missingFieldNames[fieldName] = (missingFieldNames[fieldName] || 0) + 1;
    }

    if (issue.issue_type === "duplicate" && issue.related_records) {
      const count = issue.related_records.length;
      const bucket = count >= 3 ? "3+_records" : `${count + 1}_records`;
      duplicateRelatedCounts[bucket] =
        (duplicateRelatedCounts[bucket] || 0) + 1;
    }

    if (metadata.target_entity) {
      const target = String(metadata.target_entity);
      targetEntities[target] = (targetEntities[target] || 0) + 1;
    }
  }

  const summary: IssueSummary = {
    total_issues: issues.length,
    by_entity: byEntity,
    by_type: byType,
    by_severity: bySeverity,
    by_rule: byRule,
    by_status: byStatus,
    metadata_summary: {
      missing_field_names: missingFieldNames,
      duplicate_related_counts: duplicateRelatedCounts,
      target_entities: targetEntities,
    },
  };

  return JSON.stringify(summary);
}

/**
 * Group unique record IDs by entity from the issues list.
 * Includes related_records from duplicate issues.
 * Used by the backend to know which records to fetch if GPT calls the tool.
 */
export function buildRecordIdsByEntity(
  issues: Issue[]
): Record<string, string[]> {
  const byEntity: Record<string, Set<string>> = {};

  for (const issue of issues) {
    if (!byEntity[issue.entity]) {
      byEntity[issue.entity] = new Set();
    }
    byEntity[issue.entity].add(issue.record_id);

    // Include related records from duplicate issues
    if (issue.related_records) {
      for (const relatedId of issue.related_records) {
        byEntity[issue.entity].add(relatedId);
      }
    }
  }

  // Convert sets to arrays
  const result: Record<string, string[]> = {};
  for (const [entity, ids] of Object.entries(byEntity)) {
    result[entity] = Array.from(ids);
  }
  return result;
}
