import { useState, useCallback } from "react";
import { auth } from "../config/firebase";
import { API_BASE } from "../config/api";
import type { AirtableRecord } from "./useAirtableRecords";

interface MergeResult {
  primary_record: AirtableRecord;
  deleted: Array<{ id: string; deleted: boolean }>;
  errors: Array<{ id: string; error: string }>;
  success: boolean;
}

export function useRemediateActions() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const getAuthHeaders = useCallback(async () => {
    const user = auth.currentUser;
    if (!user) throw new Error("Not authenticated");
    const token = await user.getIdToken();
    return {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
  }, []);

  const updateRecord = useCallback(
    async (
      entity: string,
      recordId: string,
      fields: Record<string, unknown>
    ): Promise<AirtableRecord> => {
      setLoading(true);
      setError(null);
      try {
        const headers = await getAuthHeaders();
        const response = await fetch(
          `${API_BASE}/airtable/records/${encodeURIComponent(entity)}/${encodeURIComponent(recordId)}`,
          {
            method: "PATCH",
            headers,
            body: JSON.stringify({ fields }),
          }
        );
        if (!response.ok) {
          const err = await response
            .json()
            .catch(() => ({ detail: "Update failed" }));
          throw new Error(
            typeof err.detail === "string" ? err.detail : "Update failed"
          );
        }
        const data = await response.json();
        setLoading(false);
        return data.record;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Update failed";
        setError(message);
        setLoading(false);
        throw err;
      }
    },
    [getAuthHeaders]
  );

  const deleteRecord = useCallback(
    async (
      entity: string,
      recordId: string
    ): Promise<{ id: string; deleted: boolean }> => {
      setLoading(true);
      setError(null);
      try {
        const headers = await getAuthHeaders();
        const response = await fetch(
          `${API_BASE}/airtable/records/${encodeURIComponent(entity)}/${encodeURIComponent(recordId)}`,
          {
            method: "DELETE",
            headers,
          }
        );
        if (!response.ok) {
          const err = await response
            .json()
            .catch(() => ({ detail: "Delete failed" }));
          throw new Error(
            typeof err.detail === "string" ? err.detail : "Delete failed"
          );
        }
        const data = await response.json();
        setLoading(false);
        return data;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Delete failed";
        setError(message);
        setLoading(false);
        throw err;
      }
    },
    [getAuthHeaders]
  );

  const mergeRecords = useCallback(
    async (
      entity: string,
      primaryRecordId: string,
      secondaryRecordIds: string[],
      mergedFields: Record<string, unknown>
    ): Promise<MergeResult> => {
      setLoading(true);
      setError(null);
      try {
        const headers = await getAuthHeaders();
        const response = await fetch(
          `${API_BASE}/airtable/records/${encodeURIComponent(entity)}/merge`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              primary_record_id: primaryRecordId,
              secondary_record_ids: secondaryRecordIds,
              merged_fields: mergedFields,
            }),
          }
        );
        if (!response.ok) {
          const err = await response
            .json()
            .catch(() => ({ detail: "Merge failed" }));
          throw new Error(
            typeof err.detail === "string" ? err.detail : "Merge failed"
          );
        }
        const data = await response.json();
        setLoading(false);
        return data;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Merge failed";
        setError(message);
        setLoading(false);
        throw err;
      }
    },
    [getAuthHeaders]
  );

  const resolveIssues = useCallback(
    async (
      recordIds: string[],
      entity: string,
      ruleIds?: string[]
    ): Promise<{ resolved_count: number; errors: Array<{ record_id: string; error: string }> }> => {
      try {
        const headers = await getAuthHeaders();
        const response = await fetch(
          `${API_BASE}/integrity/issues/resolve`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              record_ids: recordIds,
              entity,
              rule_ids: ruleIds || null,
            }),
          }
        );
        if (!response.ok) {
          const err = await response
            .json()
            .catch(() => ({ detail: "Resolve failed" }));
          console.error("Failed to resolve issues:", err);
          return { resolved_count: 0, errors: [] };
        }
        return await response.json();
      } catch (err) {
        console.error("Failed to resolve issues:", err);
        return { resolved_count: 0, errors: [] };
      }
    },
    [getAuthHeaders]
  );

  const dismissDuplicate = useCallback(
    async (
      entity: string,
      recordIds: string[],
      ruleId?: string
    ): Promise<{ dismissal_id: string; resolved_count: number }> => {
      setLoading(true);
      setError(null);
      try {
        const headers = await getAuthHeaders();
        const response = await fetch(
          `${API_BASE}/integrity/issues/dismiss`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              entity,
              record_ids: recordIds,
              rule_id: ruleId || null,
            }),
          }
        );
        if (!response.ok) {
          const err = await response
            .json()
            .catch(() => ({ detail: "Dismiss failed" }));
          throw new Error(
            typeof err.detail === "string" ? err.detail : "Dismiss failed"
          );
        }
        const data = await response.json();
        setLoading(false);
        return data;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Dismiss failed";
        setError(message);
        setLoading(false);
        throw err;
      }
    },
    [getAuthHeaders]
  );

  return {
    loading,
    error,
    updateRecord,
    deleteRecord,
    mergeRecords,
    resolveIssues,
    dismissDuplicate,
    clearError: () => setError(null),
  };
}
