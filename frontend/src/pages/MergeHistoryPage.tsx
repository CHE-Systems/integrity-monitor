import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { auth } from "../config/firebase";
import { API_BASE } from "../config/api";
import ConfirmModal from "../components/ConfirmModal";

export function MergeHistoryPage() {
  const navigate = useNavigate();
  const [mergeHistory, setMergeHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [undoConfirmId, setUndoConfirmId] = useState<string | null>(null);
  const [undoLoading, setUndoLoading] = useState(false);
  const [undoMessage, setUndoMessage] = useState<string | null>(null);

  const fetchMergeHistory = useCallback(async () => {
    setLoading(true);
    try {
      const user = auth.currentUser;
      if (!user) return;
      const token = await user.getIdToken();
      const response = await fetch(`${API_BASE}/merge-history?limit=50`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.ok) {
        const data = await response.json();
        setMergeHistory(data.merge_history || []);
      }
    } catch (err) {
      console.warn("Failed to fetch merge history:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMergeHistory();
  }, [fetchMergeHistory]);

  const handleUndo = useCallback(
    async (mergeId: string) => {
      setUndoConfirmId(null);
      setUndoLoading(true);
      setUndoMessage(null);
      try {
        const user = auth.currentUser;
        if (!user) return;
        const token = await user.getIdToken();
        const response = await fetch(
          `${API_BASE}/merge-history/${mergeId}/undo`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
          }
        );
        if (!response.ok) {
          const err = await response
            .json()
            .catch(() => ({ detail: "Undo failed" }));
          setUndoMessage(
            `Undo failed: ${typeof err.detail === "string" ? err.detail : "Unknown error"}`
          );
          return;
        }
        setUndoMessage(
          "Undo completed successfully. Both records have been restored."
        );
        fetchMergeHistory();
      } catch (err) {
        setUndoMessage(
          `Undo failed: ${err instanceof Error ? err.message : "Unknown error"}`
        );
      } finally {
        setUndoLoading(false);
      }
    },
    [fetchMergeHistory]
  );

  return (
    <div className="space-y-6">
      <div>
        <h1
          className="text-2xl font-semibold text-[var(--text-main)]"
          style={{ fontFamily: "Outfit" }}
        >
          Merge History
        </h1>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          View past merges and undo if needed
        </p>
      </div>

      <button
        onClick={() => navigate("/issues")}
        className="text-sm text-[var(--cta-blue)] hover:underline flex items-center gap-1"
      >
        <svg
          className="w-4 h-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M15 19l-7-7 7-7"
          />
        </svg>
        Back to Issues
      </button>

      {undoMessage && (
        <div
          className={`px-5 py-3 rounded-lg text-sm ${
            undoMessage.startsWith("Undo failed")
              ? "bg-red-50 text-red-700 border border-red-200"
              : "bg-green-50 text-green-700 border border-green-200"
          }`}
        >
          {undoMessage}
        </div>
      )}

      {loading && (
        <div className="rounded-2xl border border-[var(--border)] bg-white p-8 text-center">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--brand)] mb-4" />
          <p className="text-[var(--text-muted)]">Loading merge history...</p>
        </div>
      )}

      {!loading && mergeHistory.length === 0 && (
        <div className="rounded-2xl border border-[var(--border)] bg-white p-8 text-center">
          <p className="text-[var(--text-muted)]">
            No merges have been performed yet.
          </p>
        </div>
      )}

      {!loading && mergeHistory.length > 0 && (
        <div className="rounded-2xl border border-[var(--border)] bg-white overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] bg-gray-50/30">
                <th className="px-5 py-2.5 text-left text-xs font-medium text-[var(--text-muted)]">
                  Date
                </th>
                <th className="px-5 py-2.5 text-left text-xs font-medium text-[var(--text-muted)]">
                  Name
                </th>
                <th className="px-5 py-2.5 text-left text-xs font-medium text-[var(--text-muted)]">
                  Entity
                </th>
                <th className="px-5 py-2.5 text-left text-xs font-medium text-[var(--text-muted)]">
                  Primary
                </th>
                <th className="px-5 py-2.5 text-left text-xs font-medium text-[var(--text-muted)]">
                  Secondary
                </th>
                <th className="px-5 py-2.5 text-left text-xs font-medium text-[var(--text-muted)]">
                  Status
                </th>
                <th className="px-5 py-2.5 text-right text-xs font-medium text-[var(--text-muted)]">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {mergeHistory.map((entry) => {
                const performedAt = entry.performed_at
                  ? new Date(entry.performed_at).toLocaleString("en-US", {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })
                  : "—";
                const daysSince = entry.performed_at
                  ? Math.floor(
                      (Date.now() - new Date(entry.performed_at).getTime()) /
                        86400000
                    )
                  : null;
                return (
                  <tr
                    key={entry.id}
                    className="border-b border-[var(--border)] last:border-0"
                  >
                    <td className="px-5 py-3 text-xs text-[var(--text-muted)]">
                      {performedAt}
                    </td>
                    <td className="px-5 py-3 text-sm font-medium text-[var(--text-main)] max-w-[200px] truncate">
                      {entry.display_name || (
                        <span className="text-[var(--text-muted)] italic font-normal">—</span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-xs capitalize">
                      {entry.entity}
                    </td>
                    <td className="px-5 py-3 text-xs font-mono">
                      {entry.primary_record_id?.slice(0, 10)}...
                    </td>
                    <td className="px-5 py-3 text-xs font-mono">
                      {(entry.secondary_record_ids || [])
                        .map((id: string) => id.slice(0, 10) + "...")
                        .join(", ")}
                    </td>
                    <td className="px-5 py-3">
                      <span
                        className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-medium ${
                          entry.status === "completed"
                            ? "bg-green-100 text-green-700"
                            : entry.status === "undone"
                              ? "bg-gray-100 text-gray-600"
                              : entry.status === "partial_failure"
                                ? "bg-amber-100 text-amber-700"
                                : "bg-blue-100 text-blue-700"
                        }`}
                      >
                        {entry.status}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-right">
                      {entry.status === "completed" && (
                        <button
                          onClick={() => setUndoConfirmId(entry.id)}
                          disabled={undoLoading}
                          className="text-xs text-[var(--cta-blue)] hover:underline disabled:opacity-50"
                        >
                          {daysSince !== null && daysSince > 7
                            ? "Undo (old)"
                            : "Undo"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmModal
        isOpen={undoConfirmId !== null}
        title="Undo Merge"
        message="Are you sure you want to undo this merge? The secondary record(s) will be restored and the primary record will be reverted to its pre-merge state."
        confirmLabel="Yes, Undo"
        cancelLabel="Cancel"
        isDestructive={true}
        onConfirm={() => undoConfirmId && handleUndo(undoConfirmId)}
        onCancel={() => setUndoConfirmId(null)}
      />
    </div>
  );
}
