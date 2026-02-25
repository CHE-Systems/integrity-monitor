import { useState, useEffect, useCallback } from "react";
import { auth } from "../config/firebase";
import { API_BASE } from "../config/api";

export interface RecordIssue {
  issue_type: string;
  severity: string;
  rule_id: string;
  description?: string;
  related_records?: string[];
}

export interface EntityRecord {
  record_id: string;
  issues: RecordIssue[];
}

export interface EntityGroup {
  records: EntityRecord[];
  count: number;
}

export interface RunRecordIdsResponse {
  run_id: string;
  entities: Record<string, EntityGroup>;
  total_records: number;
  total_issues: number;
}

export function useRunRecordIds(runId: string | null) {
  const [data, setData] = useState<RunRecordIdsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    if (!runId) {
      setData(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const user = auth.currentUser;
      if (!user) throw new Error("Not authenticated");
      const token = await user.getIdToken();

      const response = await fetch(
        `${API_BASE}/integrity/run/${runId}/record-ids`,
        { headers: { Authorization: `Bearer ${token}` } }
      );

      if (response.status === 404) {
        setData(null);
        setError("No issues found for this run.");
        return;
      }

      if (!response.ok) {
        const errData = await response
          .json()
          .catch(() => ({ detail: "Failed to fetch" }));
        throw new Error(
          typeof errData.detail === "string"
            ? errData.detail
            : errData.detail?.error || "Failed to fetch run record IDs"
        );
      }

      const result: RunRecordIdsResponse = await response.json();
      setData(result);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to fetch run record IDs"
      );
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return { data, loading, error, refetch: fetchData };
}
