import { useState, useEffect, useCallback, useMemo } from "react";
import {
  collection,
  query,
  where,
  orderBy,
  getDocs,
} from "firebase/firestore";
import { db } from "../config/firebase";
import type { Issue } from "./useFirestoreIssues";
import {
  normalizeEntityName,
  getEntityDisplayName,
} from "../config/entities";

export interface IssueCategory {
  entity: string;
  rawEntity: string;
  displayEntity: string;
  issueType: string;
  count: number;
  severityCounts: Record<string, number>;
}

const ISSUE_TYPE_ORDER: Record<string, number> = {
  duplicate: 0,
  missing_field: 1,
  relationship: 2,
  attendance: 3,
};

export function useIssueCategories() {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchCategories = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const issuesRef = collection(db, "integrity_issues");
      const q = query(
        issuesRef,
        where("status", "==", "open"),
        orderBy("created_at", "desc")
      );
      const snapshot = await getDocs(q);

      const transformed: Issue[] = snapshot.docs.map((doc) => {
        const data = doc.data();
        return {
          id: doc.id,
          rule_id: data.rule_id || "",
          entity: data.entity || "",
          record_id: data.record_id || "",
          severity: data.severity || "info",
          issue_type: data.issue_type || "",
          description: data.description,
          metadata: data.metadata,
          related_records: data.related_records,
          created_at: data.created_at?.toDate?.() || new Date(),
          updated_at: data.updated_at?.toDate?.() || new Date(),
          status: data.status || "open",
          run_id: data.run_id,
          first_seen_in_run: data.first_seen_in_run,
        };
      });
      setIssues(transformed);
    } catch (err: any) {
      console.error("[useIssueCategories] Firestore query error:", err);
      setError(err.message || "Failed to load issue categories");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCategories();
  }, [fetchCategories]);

  const categories = useMemo((): IssueCategory[] => {
    const groupMap = new Map<string, IssueCategory>();

    for (const issue of issues) {
      const normalized = normalizeEntityName(issue.entity);
      const key = `${normalized}:${issue.issue_type}`;

      if (!groupMap.has(key)) {
        groupMap.set(key, {
          entity: normalized,
          rawEntity: issue.entity,
          displayEntity: getEntityDisplayName(issue.entity),
          issueType: issue.issue_type,
          count: 0,
          severityCounts: {},
        });
      }

      const group = groupMap.get(key)!;
      group.count++;
      group.severityCounts[issue.severity] =
        (group.severityCounts[issue.severity] || 0) + 1;
    }

    return Array.from(groupMap.values()).sort((a, b) => {
      const orderA = ISSUE_TYPE_ORDER[a.issueType] ?? 99;
      const orderB = ISSUE_TYPE_ORDER[b.issueType] ?? 99;
      if (orderA !== orderB) return orderA - orderB;
      return b.count - a.count;
    });
  }, [issues]);

  const totalIssues = issues.length;

  return { categories, totalIssues, loading, error, refetch: fetchCategories };
}
