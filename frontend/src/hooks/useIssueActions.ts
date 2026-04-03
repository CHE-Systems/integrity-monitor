import { useState } from "react";
import { doc, updateDoc } from "firebase/firestore";
import { db, auth } from "../config/firebase";
import { API_BASE } from "../config/api";

export function useIssueActions() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const markResolved = async (issueId: string, resolutionNotes?: string) => {
    setLoading(true);
    setError(null);
    try {
      const user = auth.currentUser;
      if (!user) throw new Error("Not authenticated");

      const issueRef = doc(db, "integrity_issues", issueId);
      await updateDoc(issueRef, {
        status: "resolved",
        resolved_at: new Date(),
        resolution_notes: resolutionNotes || "",
        resolved_by: user.uid,
      });
      setLoading(false);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to mark issue as resolved");
      setLoading(false);
      throw err;
    }
  };

  const markIgnored = async (issueId: string, reason?: string) => {
    setLoading(true);
    setError(null);
    try {
      const issueRef = doc(db, "integrity_issues", issueId);
      await updateDoc(issueRef, {
        status: "ignored",
        ignored_at: new Date(),
        ignore_reason: reason || "",
        ignored_by: "user",
      });
      setLoading(false);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to mark issue as ignored");
      setLoading(false);
      throw err;
    }
  };

  const deleteIssue = async (issueId: string) => {
    setLoading(true);
    setError(null);
    try {
      const user = auth.currentUser;
      if (!user) throw new Error("Not authenticated");

      // Get Firebase ID token for API authentication
      const token = await user.getIdToken();

      const response = await fetch(`${API_BASE}/integrity/issue/${issueId}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        const errorData = await response
          .json()
          .catch(() => ({ error: "Failed to delete issue" }));
        throw new Error(errorData.error || "Failed to delete issue");
      }

      setLoading(false);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete issue");
      setLoading(false);
      throw err;
    }
  };

  const countBulkDeleteIssues = async (filters: {
    issueTypes?: string[];
    entities?: string[];
    dateRange: "past_hour" | "past_day" | "past_week" | "custom" | "all";
    customStartDate?: string;
    customEndDate?: string;
  }): Promise<number> => {
    try {
      const user = auth.currentUser;
      if (!user) throw new Error("Not authenticated");

      const token = await user.getIdToken();

      const params = new URLSearchParams();
      params.append("date_range", filters.dateRange);

      if (filters.issueTypes && filters.issueTypes.length > 0) {
        filters.issueTypes.forEach((type) => {
          params.append("issue_types", type);
        });
      }

      if (filters.entities && filters.entities.length > 0) {
        filters.entities.forEach((entity) => {
          params.append("entities", entity);
        });
      }

      if (filters.dateRange === "custom") {
        if (filters.customStartDate) {
          const startDate = new Date(filters.customStartDate);
          params.append("custom_start_date", startDate.toISOString());
        }
        if (filters.customEndDate) {
          const endDate = new Date(filters.customEndDate);
          params.append("custom_end_date", endDate.toISOString());
        }
      }

      const response = await fetch(`${API_BASE}/integrity/issues/bulk/count?${params.toString()}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        const errorData = await response
          .json()
          .catch(() => ({ error: "Failed to count issues" }));
        throw new Error(errorData.error || "Failed to count issues");
      }

      const result = await response.json();
      return result.count || 0;
    } catch (err) {
      throw err instanceof Error ? err : new Error("Failed to count issues");
    }
  };

  const bulkDeleteIssues = async (
    filters: {
      issueTypes?: string[];
      entities?: string[];
      dateRange: "past_hour" | "past_day" | "past_week" | "custom" | "all";
      customStartDate?: string;
      customEndDate?: string;
    },
    onProgress?: (current: number, total: number) => void
  ) => {
    setLoading(true);
    setError(null);
    try {
      const user = auth.currentUser;
      if (!user) throw new Error("Not authenticated");

      // Get Firebase ID token for API authentication
      const token = await user.getIdToken();

      // Build query parameters
      const params = new URLSearchParams();
      params.append("date_range", filters.dateRange);
      
      if (filters.issueTypes && filters.issueTypes.length > 0) {
        filters.issueTypes.forEach((type) => {
          params.append("issue_types", type);
        });
      }
      
      if (filters.entities && filters.entities.length > 0) {
        filters.entities.forEach((entity) => {
          params.append("entities", entity);
        });
      }
      
      if (filters.dateRange === "custom") {
        if (filters.customStartDate) {
          // Convert datetime-local format to ISO string
          const startDate = new Date(filters.customStartDate);
          params.append("custom_start_date", startDate.toISOString());
        }
        if (filters.customEndDate) {
          // Convert datetime-local format to ISO string
          const endDate = new Date(filters.customEndDate);
          params.append("custom_end_date", endDate.toISOString());
        }
      }

      const response = await fetch(`${API_BASE}/integrity/issues/bulk?${params.toString()}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        const errorData = await response
          .json()
          .catch(() => ({ error: "Failed to bulk delete issues" }));
        throw new Error(errorData.error || "Failed to bulk delete issues");
      }

      const result = await response.json();
      setLoading(false);
      return result.deleted_count || 0;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to bulk delete issues");
      setLoading(false);
      throw err;
    }
  };

  return {
    markResolved,
    markIgnored,
    deleteIssue,
    bulkDeleteIssues,
    countBulkDeleteIssues,
    loading,
    error,
  };
}

