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
import type { RecordIssue, EntityRecord } from "./useRunRecordIds";

/**
 * Fetches open issues for a specific entity + issue_type from Firestore
 * and groups them by record_id into EntityRecord[]-like structure for the queue.
 */
export function useCategoryQueue(
  entity: string | null,
  issueType: string | null
) {
  const [records, setRecords] = useState<EntityRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchQueue = useCallback(async () => {
    if (!entity || !issueType) {
      setRecords([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const issuesRef = collection(db, "integrity_issues");
      const q = query(
        issuesRef,
        where("entity", "==", entity),
        where("issue_type", "==", issueType),
        where("status", "==", "open"),
        orderBy("created_at", "desc")
      );
      const snapshot = await getDocs(q);

      const recordMap = new Map<string, RecordIssue[]>();

      for (const doc of snapshot.docs) {
        const data = doc.data();
        const recordId: string = data.record_id || "";
        if (!recordId) continue;

        const issue: RecordIssue = {
          issue_type: data.issue_type || "",
          severity: data.severity || "info",
          rule_id: data.rule_id || "",
          description: data.description,
          related_records: data.related_records,
        };

        if (!recordMap.has(recordId)) {
          recordMap.set(recordId, []);
        }
        recordMap.get(recordId)!.push(issue);
      }

      const grouped: EntityRecord[] = Array.from(recordMap.entries()).map(
        ([record_id, issues]) => ({ record_id, issues })
      );

      setRecords(grouped);
    } catch (err: any) {
      console.error("[useCategoryQueue] Firestore query error:", err);
      setError(err.message || "Failed to load queue");
    } finally {
      setLoading(false);
    }
  }, [entity, issueType]);

  useEffect(() => {
    fetchQueue();
  }, [fetchQueue]);

  const totalRecords = records.length;

  const severityCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const record of records) {
      for (const issue of record.issues) {
        counts[issue.severity] = (counts[issue.severity] || 0) + 1;
      }
    }
    return counts;
  }, [records]);

  return {
    records,
    totalRecords,
    severityCounts,
    loading,
    error,
    refetch: fetchQueue,
  };
}
