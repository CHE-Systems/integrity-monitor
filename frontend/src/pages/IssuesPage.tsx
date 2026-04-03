import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { IssueList } from "../components/IssueList";
import { useIssueCounts } from "../hooks/useIssueCounts";
import { useIssueActions } from "../hooks/useIssueActions";
import { useIssueCategories } from "../hooks/useIssueCategories";
import { BulkDeleteModal } from "../components/BulkDeleteModal";
import ConfirmModal from "../components/ConfirmModal";
import deleteSweepIcon from "../assets/delete_sweep.svg";

const ISSUE_TYPE_LABELS: Record<string, string> = {
  duplicate: "Duplicates",
  missing_field: "Missing Fields",
  missing_link: "Missing Links",
  relationship: "Relationship Issues",
  attendance: "Attendance Issues",
};

const ISSUE_TYPE_ICONS: Record<string, string> = {
  duplicate:
    "M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z",
  missing_field:
    "M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z",
  missing_link:
    "M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1",
  relationship:
    "M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z",
  attendance:
    "M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2",
};

function getSeverityColor(severity: string): string {
  switch (severity) {
    case "critical":
      return "bg-red-100 text-red-700";
    case "warning":
      return "bg-yellow-100 text-yellow-700";
    case "info":
      return "bg-blue-100 text-blue-700";
    default:
      return "bg-gray-100 text-gray-700";
  }
}

export function IssuesPage() {
  const navigate = useNavigate();
  const { counts: issueCounts, loading: countsLoading } = useIssueCounts();
  const { bulkDeleteIssues, countBulkDeleteIssues } = useIssueActions();
  const {
    categories,
    loading: categoriesLoading,
  } = useIssueCategories();
  const [showBulkDelete, setShowBulkDelete] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [deleteFilters, setDeleteFilters] = useState<{
    issueTypes: string[];
    entities: string[];
    dateRange: "past_hour" | "past_day" | "past_week" | "custom" | "all";
    customStartDate?: string;
    customEndDate?: string;
  } | null>(null);
  const [deleteResult, setDeleteResult] = useState<{
    success: boolean;
    count?: number;
    message?: string;
  } | null>(null);
  const [issueListKey, setIssueListKey] = useState(0);
  const [deleteProgress, setDeleteProgress] = useState<{
    stage: "counting" | "deleting" | null;
    total: number;
    current: number;
  } | null>(null);

  const handleBulkDeleteConfirm = (filters: {
    issueTypes: string[];
    entities: string[];
    dateRange: "past_hour" | "past_day" | "past_week" | "custom" | "all";
    customStartDate?: string;
    customEndDate?: string;
  }) => {
    setDeleteFilters(filters);
    setShowBulkDelete(false);
    setShowConfirm(true);
  };

  const handleConfirmDelete = async () => {
    if (!deleteFilters) return;

    setShowConfirm(false);
    setDeleteProgress({ stage: "counting", total: 0, current: 0 });

    try {
      const totalCount = await countBulkDeleteIssues(deleteFilters);
      setDeleteProgress({ stage: "deleting", total: totalCount, current: 0 });

      const startTime = Date.now();
      const estimatedDuration = Math.max(2000, totalCount * 10);
      const progressInterval = setInterval(() => {
        const elapsed = Date.now() - startTime;
        const progress = Math.min(
          95,
          Math.floor((elapsed / estimatedDuration) * 100)
        );
        setDeleteProgress((prev) =>
          prev
            ? { ...prev, current: Math.floor((progress / 100) * prev.total) }
            : null
        );
      }, 100);

      const count = await bulkDeleteIssues(deleteFilters);

      clearInterval(progressInterval);
      setDeleteProgress({
        stage: "deleting",
        total: totalCount,
        current: totalCount,
      });

      setTimeout(() => {
        setDeleteProgress(null);
        setDeleteResult({ success: true, count });
        setIssueListKey((prev) => prev + 1);
        setTimeout(() => {
          setDeleteResult(null);
          setDeleteFilters(null);
        }, 3000);
      }, 500);
    } catch (error) {
      setDeleteProgress(null);
      setDeleteResult({
        success: false,
        message:
          error instanceof Error ? error.message : "Failed to delete issues",
      });
      setTimeout(() => {
        setDeleteResult(null);
        setDeleteFilters(null);
      }, 5000);
    }
  };

  return (
    <div className="space-y-6">
      {/* Progress Bar */}
      {deleteProgress && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <div className="animate-spin rounded-full h-4 w-4 border-2 border-blue-600 border-t-transparent"></div>
              <span className="text-sm font-medium text-blue-800">
                {deleteProgress.stage === "counting"
                  ? "Loading issues to delete..."
                  : `Deleting issues: ${deleteProgress.current.toLocaleString()} / ${deleteProgress.total.toLocaleString()}`}
              </span>
            </div>
            {deleteProgress.stage === "deleting" && (
              <span className="text-sm text-blue-600">
                {deleteProgress.total > 0
                  ? Math.round(
                      (deleteProgress.current / deleteProgress.total) * 100
                    )
                  : 0}
                %
              </span>
            )}
          </div>
          {deleteProgress.stage === "deleting" && deleteProgress.total > 0 && (
            <div className="w-full bg-blue-200 rounded-full h-2">
              <div
                className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                style={{
                  width: `${Math.min(100, (deleteProgress.current / deleteProgress.total) * 100)}%`,
                }}
              ></div>
            </div>
          )}
        </div>
      )}

      <div className="flex items-center justify-between">
        <div>
          <h1
            className="text-3xl font-semibold text-[var(--text-main)] mb-2"
            style={{ fontFamily: "Outfit" }}
          >
            Issues
          </h1>
          <p className="text-[var(--text-muted)]">
            View and fix data integrity issues across the system
          </p>
        </div>
        <div className="flex gap-3">
          <button
            onClick={() => navigate("/issues/history")}
            className="p-2 rounded-lg border border-[var(--border)] bg-white hover:bg-[var(--bg-mid)] transition-colors"
            title="Merge History"
          >
            <svg
              className="w-5 h-5 text-[var(--text-muted)]"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          </button>
          <button
            onClick={() => navigate("/rules")}
            className="px-4 py-2 border border-[var(--cta-blue)] bg-white text-[var(--cta-blue)] rounded-lg hover:bg-[var(--cta-blue)]/5 transition-colors"
          >
            View Rules
          </button>
          <button
            onClick={() => setShowBulkDelete(true)}
            className="p-2 rounded-lg border border-red-300 bg-red-50 hover:bg-red-100 transition-colors"
            title="Bulk Delete Issues"
          >
            <img
              src={deleteSweepIcon}
              alt="Bulk Delete"
              className="w-6 h-6"
              style={{
                filter:
                  "brightness(0) saturate(100%) invert(20%) sepia(100%) saturate(5000%) hue-rotate(350deg) brightness(90%) contrast(100%)",
              }}
            />
          </button>
        </div>
      </div>

      {deleteResult && (
        <div
          className={`p-4 rounded-lg border ${
            deleteResult.success
              ? "bg-green-50 border-green-200 text-green-800"
              : "bg-red-50 border-red-200 text-red-800"
          }`}
        >
          {deleteResult.success
            ? `Successfully deleted ${deleteResult.count || 0} issues.`
            : `Error: ${deleteResult.message || "Failed to delete issues"}`}
        </div>
      )}

      {/* Issue Counts */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-mid)]/70 p-4">
          <p className="text-sm text-[var(--text-muted)]">Total Issues</p>
          <p
            className="text-2xl font-semibold text-[var(--text-main)] mt-1"
            style={{ fontFamily: "Outfit" }}
          >
            {countsLoading ? "..." : issueCounts.all}
          </p>
        </div>
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-mid)]/70 p-4">
          <p className="text-sm text-[var(--text-muted)]">Open</p>
          <p
            className="text-2xl font-semibold text-[var(--text-main)] mt-1"
            style={{ fontFamily: "Outfit" }}
          >
            {countsLoading ? "..." : issueCounts.open}
          </p>
        </div>
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-mid)]/70 p-4">
          <p className="text-sm text-[var(--text-muted)]">Closed</p>
          <p
            className="text-2xl font-semibold text-[var(--text-main)] mt-1"
            style={{ fontFamily: "Outfit" }}
          >
            {countsLoading ? "..." : issueCounts.closed}
          </p>
        </div>
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-mid)]/70 p-4">
          <p className="text-sm text-[var(--text-muted)]">Resolved</p>
          <p
            className="text-2xl font-semibold text-[var(--text-main)] mt-1"
            style={{ fontFamily: "Outfit" }}
          >
            {countsLoading ? "..." : issueCounts.resolved}
          </p>
        </div>
      </div>

      {/* Category Cards */}
      {!categoriesLoading && categories.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {categories.map((cat) => (
            <button
              key={`${cat.entity}:${cat.issueType}`}
              onClick={() =>
                navigate(
                  `/issues/queue?entity=${encodeURIComponent(cat.rawEntity)}&type=${encodeURIComponent(cat.issueType)}`
                )
              }
              className="rounded-2xl border border-[var(--border)] bg-white p-5 text-left hover:border-[var(--brand)]/50 hover:shadow-sm transition-all group"
            >
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="rounded-lg bg-[var(--bg-mid)] p-2">
                    <svg
                      className="w-5 h-5 text-[var(--text-muted)]"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={1.5}
                        d={
                          ISSUE_TYPE_ICONS[cat.issueType] ||
                          "M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
                        }
                      />
                    </svg>
                  </div>
                  <div>
                    <h3
                      className="text-sm font-semibold text-[var(--text-main)] group-hover:text-[var(--brand)] transition-colors"
                      style={{ fontFamily: "Outfit" }}
                    >
                      {cat.displayEntity}{" "}
                      {ISSUE_TYPE_LABELS[cat.issueType] || cat.issueType}
                    </h3>
                    <p className="text-xs text-[var(--text-muted)] mt-0.5">
                      {cat.count} issue{cat.count !== 1 ? "s" : ""} to review
                    </p>
                  </div>
                </div>
                <svg
                  className="w-4 h-4 text-[var(--text-muted)] group-hover:text-[var(--brand)] transition-colors"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 5l7 7-7 7"
                  />
                </svg>
              </div>
              <div className="flex gap-2 mt-3">
                {Object.entries(cat.severityCounts)
                  .sort(([a], [b]) => {
                    const order: Record<string, number> = {
                      critical: 0,
                      warning: 1,
                      info: 2,
                    };
                    return (order[a] ?? 3) - (order[b] ?? 3);
                  })
                  .map(([severity, count]) => (
                    <span
                      key={severity}
                      className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${getSeverityColor(severity)}`}
                    >
                      {count} {severity}
                    </span>
                  ))}
              </div>
            </button>
          ))}
        </div>
      )}

      {categoriesLoading && (
        <div className="rounded-2xl border border-[var(--border)] bg-white p-8 text-center">
          <div className="inline-block animate-spin rounded-full h-6 w-6 border-b-2 border-[var(--brand)] mb-2" />
          <p className="text-[var(--text-muted)] text-sm">
            Loading categories...
          </p>
        </div>
      )}

      {/* Issue List with integrated filters */}
      <div className="overflow-hidden rounded-3xl border border-[var(--border)] bg-white p-6">
        <IssueList key={issueListKey} />
      </div>

      <BulkDeleteModal
        isOpen={showBulkDelete}
        onClose={() => setShowBulkDelete(false)}
        onConfirm={handleBulkDeleteConfirm}
      />

      <ConfirmModal
        isOpen={showConfirm}
        title="Confirm Bulk Delete"
        message={
          deleteFilters
            ? `Are you sure you want to delete issues matching your criteria? This action cannot be undone.`
            : ""
        }
        confirmLabel="Yes, Delete"
        cancelLabel="Cancel"
        isDestructive={true}
        onConfirm={handleConfirmDelete}
        onCancel={() => {
          setShowConfirm(false);
          setDeleteFilters(null);
        }}
      />
    </div>
  );
}
