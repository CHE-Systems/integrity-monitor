import { useState, useEffect, useMemo, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import type { IssueFilters, Issue } from "../hooks/useFirestoreIssues";
import { useFirestoreIssues, fetchAllIssues } from "../hooks/useFirestoreIssues";
import { useIssueCounts } from "../hooks/useIssueCounts";
import { useIssueActions } from "../hooks/useIssueActions";
import { getAirtableLinksWithFallback } from "../utils/airtable";
import { useAirtableSchema } from "../contexts/AirtableSchemaContext";
import { useRecordDisplayNames } from "../hooks/useRecordDisplayNames";
import { formatRuleId } from "../utils/ruleFormatter";
import { ACTIVE_ENTITIES, ENTITY_TABLE_MAPPING } from "../config/entities";
import ConfirmModal from "./ConfirmModal";
import { Pagination } from "./Pagination";
import { IssueChatPanel } from "./IssueChatPanel";
import openInNewTabIcon from "../assets/open_in_new_tab.svg";
import arrowLeftIcon from "../assets/keyboard_arrow_left.svg";
import arrowRightIcon from "../assets/keyboard_arrow_right.svg";
import doubleArrowLeftIcon from "../assets/keyboard_double_arrow_left.svg";
import doubleArrowRightIcon from "../assets/keyboard_double_arrow_right.svg";

const ITEMS_PER_PAGE = 50;

interface IssueListProps {
  filters?: IssueFilters;
  onClose?: () => void;
  totalItems?: number;
  itemsPerPage?: number;
}

export function IssueList({
  filters: initialFilters = {},
  onClose,
  totalItems,
  itemsPerPage = ITEMS_PER_PAGE,
}: IssueListProps) {
  const navigate = useNavigate();
  const { schema } = useAirtableSchema();
  // If initialFilters provided, use them (for queue filtering from dashboard)
  // Otherwise default to showing all open issues
  const [filters, setFilters] = useState<IssueFilters>(
    initialFilters || { status: "open" }
  );
  const [search, setSearch] = useState("");
  const [pageInput, setPageInput] = useState("");
  const [chatOpen, setChatOpen] = useState(false);
  const [chatIssues, setChatIssues] = useState<Issue[]>([]);
  const [chatLoading, setChatLoading] = useState(false);

  // Track if we're filtering by run_id (from RunStatusPage)
  const isRunSpecificView = Boolean(initialFilters?.run_id);
  // When totalItems is provided, use default pagination
  const useDefaultPagination = totalItems !== undefined;

  // Sync filters when initialFilters change (from parent component like DashboardContent or RunStatusPage)
  useEffect(() => {
    if (initialFilters) {
      // When filters come from parent (like queue selection or run status page), replace filters completely
      // This ensures queue filtering and run-specific filtering works correctly
      setFilters({
        ...initialFilters,
        // Default to "open" status if not specified and we have a type filter (from queue)
        // But preserve "all" if explicitly set (e.g., from RunStatusPage)
        status: initialFilters.status || (initialFilters.type ? "open" : "all"),
      });
    }
  }, [
    initialFilters?.type,
    initialFilters?.severity,
    initialFilters?.entity,
    initialFilters?.status,
    initialFilters?.run_id,
    initialFilters?.first_seen_in_run,
  ]);

  // Helper to update filters while preserving run_id and first_seen_in_run from initial filters
  const updateFilter = (key: keyof IssueFilters, value: string | undefined) => {
    setFilters((prev) => ({
      ...prev,
      // Always preserve run_id and first_seen_in_run from initialFilters if present
      run_id: initialFilters?.run_id,
      first_seen_in_run: initialFilters?.first_seen_in_run,
      [key]: value,
    }));
  };

  // Get counts for total pages calculation
  const { counts } = useIssueCounts();

  const {
    data: issues,
    loading,
    error,
    hasMore,
    hasPrev,
    currentPage,
    nextPage,
    prevPage,
    goToPage,
    goToLastPage,
  } = useFirestoreIssues(filters, itemsPerPage);

  // Calculate total pages based on filtered count
  // When viewing run-specific issues, we can't use global counts - pagination is based on query results
  const getFilteredCount = () => {
    // For run-specific views with totalItems provided, use that
    if (useDefaultPagination && totalItems !== undefined) {
      return totalItems;
    }
    // For run-specific views without totalItems, we don't have accurate total counts
    if (isRunSpecificView) {
      // Return a placeholder - the actual count will be shown from query results
      return -1;
    }
    if (filters.status === "open") return counts.open;
    if (filters.status === "closed") return counts.closed;
    if (filters.status === "resolved") return counts.resolved;
    return counts.all;
  };
  const filteredCount = getFilteredCount();
  const totalPages = filteredCount > 0 ? Math.ceil(filteredCount / itemsPerPage) : 1;

  // Calculate pagination values for default pagination component
  const startIndex = useDefaultPagination && totalItems !== undefined 
    ? (currentPage - 1) * itemsPerPage 
    : 0;
  const endIndex = useDefaultPagination && totalItems !== undefined
    ? Math.min(startIndex + itemsPerPage, totalItems)
    : 0;

  // Stable reference for record display name lookups
  const issueEntries = useMemo(
    () => issues.map((i) => ({ record_id: i.record_id, entity: i.entity })),
    [issues]
  );
  const recordDisplayNames = useRecordDisplayNames(issueEntries);

  // Client-side search: filter by rule_id, record_id, description, AND display name
  const filteredIssues = useMemo(() => {
    if (!search) return issues;
    const searchLower = search.toLowerCase();
    return issues.filter(
      (issue) =>
        issue.rule_id.toLowerCase().includes(searchLower) ||
        issue.record_id.toLowerCase().includes(searchLower) ||
        issue.description?.toLowerCase().includes(searchLower) ||
        recordDisplayNames[issue.record_id]?.toLowerCase().includes(searchLower)
    );
  }, [issues, search, recordDisplayNames]);

  const { deleteIssue } = useIssueActions();
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{
    isOpen: boolean;
    issueId: string | null;
  }>({ isOpen: false, issueId: null });

  const initiateDelete = (issueId: string) => {
    setDeleteConfirm({ isOpen: true, issueId });
  };

  const handleConfirmDelete = async () => {
    const issueId = deleteConfirm.issueId;
    if (!issueId) return;

    setDeleteConfirm({ isOpen: false, issueId: null });
    setDeletingId(issueId);
    try {
      await deleteIssue(issueId);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to delete issue");
    } finally {
      setDeletingId(null);
    }
  };

  const handleSearch = (value: string) => {
    setSearch(value);
  };

  const handleOpenChat = useCallback(async () => {
    setChatOpen(true);
    setChatLoading(true);
    try {
      // Fetch all issues matching current filters (up to 500) for complete context
      const allIssues = await fetchAllIssues({ ...filters, search });
      setChatIssues(allIssues);
    } catch (err) {
      console.error("[IssueList] Failed to fetch issues for chat:", err);
      // Fall back to currently loaded page of issues
      setChatIssues(issues);
    } finally {
      setChatLoading(false);
    }
  }, [filters, search, issues]);

  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case "critical":
        return "bg-[#f8d7da] text-[#a61b2b]";
      case "warning":
        return "bg-[#ffecc7] text-[#b35300]";
      default:
        return "bg-[#d7ecff] text-[#22598c]";
    }
  };

  const formatAge = (date: Date | undefined) => {
    if (!date) return "Unknown";
    const now = new Date();
    const timeValue = date.getTime();
    if (isNaN(timeValue)) return "Unknown";

    const diffMs = now.getTime() - timeValue;
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffMinutes = Math.floor(diffMs / (1000 * 60));

    if (diffDays > 0) return `${diffDays}d`;
    if (diffHours > 0) return `${diffHours}h`;
    if (diffMinutes > 0) return `${diffMinutes}m`;
    return "Just now";
  };

  return (
    <div className="space-y-4">
      {onClose && (
        <div className="flex items-center justify-between">
          <h2
            className="text-xl font-semibold text-[var(--text-main)]"
            style={{ fontFamily: "Outfit" }}
          >
            Issue Details
          </h2>
          <button
            onClick={onClose}
            className="text-[var(--text-muted)] hover:text-[var(--text-main)]"
            aria-label="Close"
          >
            ×
          </button>
        </div>
      )}

      {/* Filters Row */}
      <div className="flex flex-wrap gap-2">
        <input
          type="text"
          placeholder="Search by name, rule ID, or record ID..."
          value={search}
          onChange={(e) => handleSearch(e.target.value)}
          className="flex-1 min-w-[200px] rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-[var(--text-main)]"
        />
        <select
          value={filters.status || "all"}
          onChange={(e) => updateFilter("status", e.target.value)}
          className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-[var(--text-main)]"
        >
          <option value="all">All Statuses</option>
          <option value="open">Open</option>
          <option value="closed">Closed</option>
          <option value="resolved">Resolved</option>
          <option value="auto_resolved">Auto-resolved</option>
        </select>
        <select
          value={filters.type || ""}
          onChange={(e) => updateFilter("type", e.target.value || undefined)}
          className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-[var(--text-main)]"
        >
          <option value="">All Types</option>
          <option value="duplicate">Duplicate</option>
          <option value="missing_link">Missing Link</option>
          <option value="missing_field">Missing Field</option>
          <option value="attendance">Attendance</option>
        </select>
        <select
          value={filters.severity || ""}
          onChange={(e) => updateFilter("severity", e.target.value || undefined)}
          className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-[var(--text-main)]"
        >
          <option value="">All Severities</option>
          <option value="critical">Critical</option>
          <option value="warning">Warning</option>
          <option value="info">Info</option>
        </select>
        <select
          value={filters.entity || ""}
          onChange={(e) => updateFilter("entity", e.target.value || undefined)}
          className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-[var(--text-main)]"
        >
          <option value="">All Entities</option>
          {ACTIVE_ENTITIES.map((entity) => (
            <option key={entity} value={entity}>
              {ENTITY_TABLE_MAPPING[entity] || entity}
            </option>
          ))}
        </select>
        <button
          onClick={handleOpenChat}
          disabled={filteredIssues.length === 0}
          className="flex items-center gap-1.5 rounded-lg border border-[var(--brand)] bg-[var(--brand)]/5 px-3 py-2 text-sm text-[var(--brand)] hover:bg-[var(--brand)]/15 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          title="Ask AI about these issues"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2L2 7l10 5 10-5-10-5z" />
            <path d="M2 17l10 5 10-5" />
            <path d="M2 12l10 5 10-5" />
          </svg>
          Ask AI
        </button>
      </div>

      {/* Pagination */}
      {!loading && !error && filteredIssues.length > 0 && (
        <>
          {useDefaultPagination && totalItems !== undefined ? (
            <Pagination
              currentPage={currentPage}
              totalPages={totalPages}
              totalItems={totalItems}
              itemsPerPage={itemsPerPage}
              startIndex={startIndex}
              endIndex={endIndex}
              onPageChange={(page) => goToPage(page, totalPages)}
              itemLabel="issues"
              alwaysShow={true}
            />
          ) : (
            <div className="flex items-center justify-between text-sm py-2">
              <div className="text-[var(--text-muted)]">
                {filteredIssues.length} issues shown
                {!isRunSpecificView && ` · ${filteredCount} total`}
                {isRunSpecificView && hasMore && " · more available"}
              </div>
              <div className="flex items-center gap-1">
                {!isRunSpecificView && (
                  <button
                    onClick={() => goToPage(1)}
                    disabled={currentPage === 1 || loading}
                    className={`rounded-lg border border-[var(--text-main)] p-1.5 hover:bg-[var(--bg-mid)] ${
                      currentPage === 1 || loading
                        ? "cursor-not-allowed opacity-40"
                        : ""
                    }`}
                    title="First page"
                  >
                    <img
                      src={doubleArrowLeftIcon}
                      alt="First"
                      className="w-5 h-5"
                      style={{
                        filter:
                          "brightness(0) saturate(100%) invert(12%) sepia(30%) saturate(1200%) hue-rotate(140deg) brightness(0.31) contrast(1.2)",
                      }}
                    />
                  </button>
                )}
                <button
                  onClick={prevPage}
                  disabled={!hasPrev || loading}
                  className={`rounded-lg border border-[var(--text-main)] p-1.5 hover:bg-[var(--bg-mid)] ${
                    !hasPrev || loading ? "cursor-not-allowed opacity-40" : ""
                  }`}
                  title="Previous page"
                >
                  <img
                    src={arrowLeftIcon}
                    alt="Previous"
                    className="w-5 h-5"
                    style={{
                      filter:
                        "brightness(0) saturate(100%) invert(12%) sepia(30%) saturate(1200%) hue-rotate(140deg) brightness(0.31) contrast(1.2)",
                    }}
                  />
                </button>
                <div className="flex items-center gap-1 mx-1">
                  <span className="text-[var(--text-muted)]">Page</span>
                  {isRunSpecificView ? (
                    <span className="px-2 py-1 text-sm text-[var(--text-main)]">
                      {currentPage}
                    </span>
                  ) : (
                    <>
                      <input
                        type="number"
                        min={1}
                        max={totalPages}
                        value={pageInput !== "" ? pageInput : currentPage}
                        onChange={(e) => setPageInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            const page = parseInt(pageInput, 10);
                            if (!isNaN(page) && page >= 1 && page <= totalPages) {
                              goToPage(page, totalPages);
                              setPageInput("");
                            }
                          }
                        }}
                        onBlur={() => setPageInput("")}
                        className="w-14 rounded-lg border border-[var(--text-main)] px-2 py-1 text-sm text-center text-[var(--text-main)]"
                      />
                      <span className="text-[var(--text-muted)]">of {totalPages}</span>
                    </>
                  )}
                </div>
                <button
                  onClick={nextPage}
                  disabled={!hasMore || loading}
                  className={`rounded-lg border border-[var(--text-main)] p-1.5 hover:bg-[var(--bg-mid)] ${
                    !hasMore || loading ? "cursor-not-allowed opacity-40" : ""
                  }`}
                  title="Next page"
                >
                  <img
                    src={arrowRightIcon}
                    alt="Next"
                    className="w-5 h-5"
                    style={{
                      filter:
                        "brightness(0) saturate(100%) invert(12%) sepia(30%) saturate(1200%) hue-rotate(140deg) brightness(0.31) contrast(1.2)",
                    }}
                  />
                </button>
                {!isRunSpecificView && (
                  <button
                    onClick={() => goToLastPage(totalPages)}
                    disabled={currentPage === totalPages || !hasMore || loading}
                    className={`rounded-lg border border-[var(--text-main)] p-1.5 hover:bg-[var(--bg-mid)] ${
                      currentPage === totalPages || !hasMore || loading
                        ? "cursor-not-allowed opacity-40"
                        : ""
                    }`}
                    title="Last page"
                  >
                    <img
                      src={doubleArrowRightIcon}
                      alt="Last"
                      className="w-5 h-5"
                      style={{
                        filter:
                          "brightness(0) saturate(100%) invert(12%) sepia(30%) saturate(1200%) hue-rotate(140deg) brightness(0.31) contrast(1.2)",
                      }}
                    />
                  </button>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {loading && (
        <div className="text-center py-8 text-[var(--text-muted)]">
          <div className="inline-block animate-spin rounded-full h-6 w-6 border-b-2 border-[var(--brand)] mb-2"></div>
          <p>Loading issues...</p>
        </div>
      )}

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {!loading && !error && filteredIssues.length === 0 && (
        <div className="text-center py-8 text-[var(--text-muted)]">
          No issues found
        </div>
      )}

      {!loading && !error && filteredIssues.length > 0 && (
        <>
          <div className="overflow-x-auto rounded-3xl border border-[var(--border)] bg-white">
            <table className="w-full text-left text-sm min-w-[800px]">
              <thead className="bg-[var(--bg-mid)] text-xs uppercase tracking-[0.2em] text-[var(--text-muted)]">
                <tr>
                  <th className="px-4 py-3">Rule</th>
                  <th className="px-4 py-3">Entity</th>
                  <th className="px-4 py-3">Severity</th>
                  <th className="px-4 py-3">Record</th>
                  <th className="px-4 py-3 text-right">Age</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredIssues.map((issue) => {
                  const airtableLinks = getAirtableLinksWithFallback(
                    issue.entity,
                    issue.record_id,
                    schema
                  );
                  return (
                    <tr
                      key={issue.id}
                      className="border-t border-[var(--border)]/70 cursor-pointer hover:bg-[var(--bg-mid)]/30 transition-colors"
                      onClick={() => navigate(`/issue/${issue.id}`)}
                    >
                      <td className="px-4 py-3 text-xs">
                        <span
                          className="text-[var(--text-main)]"
                          title={issue.rule_id}
                        >
                          {formatRuleId(issue.rule_id)}
                        </span>
                      </td>
                      <td className="px-4 py-3">{issue.entity}</td>
                      <td className="px-4 py-3">
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-medium uppercase tracking-wide ${getSeverityColor(
                            issue.severity
                          )}`}
                        >
                          {issue.severity}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {recordDisplayNames[issue.record_id] && (
                          <div className="text-sm font-medium text-[var(--text-main)] mb-0.5 truncate max-w-[200px]">
                            {recordDisplayNames[issue.record_id]}
                          </div>
                        )}
                        <div className="font-mono text-xs">
                          {airtableLinks?.primary ? (
                            <a
                              href={airtableLinks.primary}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="text-[var(--cta-blue)] hover:underline cursor-pointer inline-flex items-center gap-1"
                              title={`Open ${issue.record_id} in Airtable (${issue.entity})`}
                            >
                              {issue.record_id}
                              <img
                                src={openInNewTabIcon}
                                alt="Open in new tab"
                                className="w-3 h-3 inline-block"
                                style={{
                                  filter:
                                    "brightness(0) saturate(100%) invert(27%) sepia(96%) saturate(2598%) hue-rotate(210deg) brightness(97%) contrast(95%)",
                                }}
                              />
                            </a>
                          ) : (
                            <span
                              className="text-[var(--text-muted)]"
                              title={`Entity: ${issue.entity} - No Airtable mapping configured`}
                            >
                              {issue.record_id}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right text-xs text-[var(--text-muted)]">
                        {formatAge(issue.created_at)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div
                          className="flex items-center justify-end gap-2"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            type="button"
                            onClick={() => {
                              const params = new URLSearchParams({
                                entity: issue.entity,
                                record_id: issue.record_id,
                              });
                              if (issue.issue_type === "duplicate" && issue.related_records?.length) {
                                params.set("view", "merge");
                                issue.related_records.forEach((rid) => params.append("related_record", rid));
                              } else {
                                params.set("view", "edit");
                              }
                              params.set("from", "list");
                              navigate(`/issues/fix?${params.toString()}`);
                            }}
                            className="rounded-md bg-[var(--brand)] px-2.5 py-1 text-xs font-medium text-white hover:opacity-90 transition-colors"
                          >
                            Fix
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              navigate(`/issue/${issue.id}`);
                            }}
                            className="text-xs text-[var(--cta-blue)] hover:underline"
                          >
                            Details
                          </button>
                          <button
                            type="button"
                            title="Permanently remove this issue record"
                            onClick={(e) => {
                              e.stopPropagation();
                              initiateDelete(issue.id);
                            }}
                            disabled={deletingId === issue.id}
                            className="text-xs text-red-600/80 hover:text-red-700 disabled:opacity-50"
                          >
                            {deletingId === issue.id ? "..." : "Delete"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      <ConfirmModal
        isOpen={deleteConfirm.isOpen}
        title="Delete issue record"
        message="This permanently removes the issue from the database. Use only for bad scan data or mistakes. Open issues are normally cleared when the next scan no longer finds them."
        confirmLabel="Delete permanently"
        isDestructive
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteConfirm({ isOpen: false, issueId: null })}
      />

      <IssueChatPanel
        isOpen={chatOpen}
        onClose={() => setChatOpen(false)}
        issues={chatLoading ? [] : chatIssues}
      />
    </div>
  );
}
