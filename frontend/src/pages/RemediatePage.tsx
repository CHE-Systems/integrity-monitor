import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useFirestoreRuns } from "../hooks/useFirestoreRuns";
import { useRunRecordIds } from "../hooks/useRunRecordIds";
import { useAirtableRecords } from "../hooks/useAirtableRecords";
import { useAirtableSchema } from "../contexts/AirtableSchemaContext";
import type { RecordIssue, EntityRecord } from "../hooks/useRunRecordIds";
import {
  normalizeEntityName,
  getEntityDisplayName,
} from "../config/entities";
import { DuplicateMergeView } from "../components/DuplicateMergeView";
import { RecordEditor } from "../components/RecordEditor";
import { Pagination } from "../components/Pagination";
import { useRemediateActions } from "../hooks/useRemediateActions";

type ViewState =
  | { view: "overview" }
  | { view: "queue"; entity: string; issueType: string }
  | {
      view: "merge";
      entity: string;
      primaryRecordId: string;
      secondaryRecordIds: string[];
    }
  | {
      view: "edit";
      entity: string;
      recordId: string;
      issues: RecordIssue[];
    };

interface IssueGroup {
  entity: string;
  displayEntity: string;
  issueType: string;
  records: EntityRecord[];
  count: number;
  severityCounts: Record<string, number>;
}

const ISSUE_TYPE_LABELS: Record<string, string> = {
  duplicate: "Duplicates",
  missing_field: "Missing Fields",
  relationship: "Relationship Issues",
  attendance: "Attendance Issues",
};

const ISSUE_TYPE_ICONS: Record<string, string> = {
  duplicate: "M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z",
  missing_field: "M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z",
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

/** Serialize view state to URL search params. */
function viewStateToParams(
  runId: string | null,
  state: ViewState
): Record<string, string> {
  const params: Record<string, string> = {};
  if (runId) params.run_id = runId;
  if (state.view === "overview") return params;
  params.view = state.view;
  if ("entity" in state) params.entity = state.entity;
  if (state.view === "queue") params.issue_type = state.issueType;
  if (state.view === "merge") params.record_id = state.primaryRecordId;
  if (state.view === "edit") params.record_id = state.recordId;
  return params;
}

export function RemediatePage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [queuePage, setQueuePage] = useState(0);
  const [queueSearch, setQueueSearch] = useState("");
  const QUEUE_PAGE_SIZE = 20;
  const { resolveIssues } = useRemediateActions();

  // Read initial state from URL
  const selectedRunId = searchParams.get("run_id") || null;
  const urlView = searchParams.get("view") || "overview";
  const urlEntity = searchParams.get("entity") || "";
  const urlIssueType = searchParams.get("issue_type") || "";
  const urlRecordId = searchParams.get("record_id") || "";

  const { data: runs, loading: runsLoading } = useFirestoreRuns(30);
  const {
    data: recordIdsData,
    loading: dataLoading,
    error: dataError,
    refetch,
  } = useRunRecordIds(selectedRunId);

  // Filter to completed runs only
  const completedRuns = useMemo(
    () =>
      (runs || []).filter(
        (r) =>
          r.status !== "Running" &&
          r.status !== "Cancelled"
      ),
    [runs]
  );

  // Group issues by (entity, issueType)
  const issueGroups = useMemo((): IssueGroup[] => {
    if (!recordIdsData) return [];
    const groupMap = new Map<string, IssueGroup>();

    for (const [rawEntity, entityGroup] of Object.entries(
      recordIdsData.entities
    )) {
      const normalized = normalizeEntityName(rawEntity);
      const display = getEntityDisplayName(rawEntity);

      for (const record of entityGroup.records) {
        for (const issue of record.issues) {
          const key = `${normalized}:${issue.issue_type}`;
          if (!groupMap.has(key)) {
            groupMap.set(key, {
              entity: normalized,
              displayEntity: display,
              issueType: issue.issue_type,
              records: [],
              count: 0,
              severityCounts: {},
            });
          }
          const group = groupMap.get(key)!;
          // Avoid adding same record twice to this group
          if (!group.records.find((r) => r.record_id === record.record_id)) {
            group.records.push(record);
            group.count++;
          }
          group.severityCounts[issue.severity] =
            (group.severityCounts[issue.severity] || 0) + 1;
        }
      }
    }

    return Array.from(groupMap.values()).sort((a, b) => {
      // Duplicates first, then by count desc
      if (a.issueType === "duplicate" && b.issueType !== "duplicate") return -1;
      if (a.issueType !== "duplicate" && b.issueType === "duplicate") return 1;
      return b.count - a.count;
    });
  }, [recordIdsData]);

  // Reconstruct viewState from URL + data
  const viewState = useMemo((): ViewState => {
    if (urlView === "queue" && urlEntity && urlIssueType) {
      return { view: "queue", entity: urlEntity, issueType: urlIssueType };
    }
    if (urlView === "merge" && urlEntity && urlRecordId) {
      // First try to get secondary IDs from URL params (passed from IssueDetailPage)
      const secondaryFromUrl = searchParams.getAll("related_record");
      if (secondaryFromUrl.length > 0) {
        return {
          view: "merge",
          entity: urlEntity,
          primaryRecordId: urlRecordId,
          secondaryRecordIds: secondaryFromUrl,
        };
      }
      // Fallback: find the related records from loaded run data
      const group = issueGroups.find(
        (g) => g.entity === urlEntity && g.issueType === "duplicate"
      );
      const record = group?.records.find((r) => r.record_id === urlRecordId);
      const dupIssue = record?.issues.find((i) => i.issue_type === "duplicate");
      return {
        view: "merge",
        entity: urlEntity,
        primaryRecordId: urlRecordId,
        secondaryRecordIds: dupIssue?.related_records || [],
      };
    }
    if (urlView === "edit" && urlEntity && urlRecordId) {
      // Find the issues for this record from loaded data
      const matchingGroup = issueGroups.find(
        (g) => g.entity === urlEntity && g.issueType !== "duplicate"
      );
      const record = matchingGroup?.records.find(
        (r) => r.record_id === urlRecordId
      );
      return {
        view: "edit",
        entity: urlEntity,
        recordId: urlRecordId,
        issues: record?.issues || [],
      };
    }
    return { view: "overview" };
  }, [urlView, urlEntity, urlIssueType, urlRecordId, issueGroups, searchParams]);

  // Update URL when navigating
  const setView = useCallback(
    (state: ViewState) => {
      const params = viewStateToParams(selectedRunId, state);
      setSearchParams(params, { replace: false });
      if (state.view === "queue") setQueuePage(0);
    },
    [selectedRunId, setSearchParams]
  );

  // Reset search, page, and cache when queue group changes
  const queueGroupKey =
    viewState.view === "queue"
      ? `${viewState.entity}:${viewState.issueType}`
      : "";
  useEffect(() => {
    setQueueSearch("");
    setQueuePage(0);
    recordsCacheRef.current = {};
    setRecordsCacheVersion(0);
  }, [queueGroupKey]);

  // Get current queue records
  const currentQueueGroup = useMemo(() => {
    if (viewState.view !== "queue") return null;
    return issueGroups.find(
      (g) =>
        g.entity === viewState.entity && g.issueType === viewState.issueType
    );
  }, [viewState, issueGroups]);

  // Fetch Airtable records for the current page to get primary field names
  const { schema } = useAirtableSchema();
  const queueEntity = viewState.view === "queue" ? viewState.entity : undefined;

  // Cache of loaded Airtable records — persists across page changes for name search
  const recordsCacheRef = useRef<Record<string, any>>({});
  const [recordsCacheVersion, setRecordsCacheVersion] = useState(0);

  // Resolve primary field name from schema for the current queue entity
  const primaryFieldName = useMemo(() => {
    if (!schema?.tables || !queueEntity) return null;
    const normalized = normalizeEntityName(queueEntity);
    for (const table of schema.tables) {
      const tableName = table.name?.toLowerCase().replace(/ /g, "_");
      if (
        tableName === normalized ||
        normalized.includes(tableName) ||
        tableName?.includes(normalized)
      ) {
        const primaryId = table.primaryFieldId;
        if (primaryId) {
          const field = table.fields?.find((f: any) => f.id === primaryId);
          if (field) return field.name;
        }
        break;
      }
    }
    return null;
  }, [schema, queueEntity]);

  /** Extract display name from an Airtable record object using primary field. */
  const getDisplayNameFromRecord = useCallback(
    (rec: any): string | null => {
      if (!rec || !primaryFieldName) return null;
      const val = rec.fields?.[primaryFieldName];
      if (val == null || val === "") return null;
      if (typeof val === "string") return val;
      if (Array.isArray(val)) return val.length > 0 ? String(val[0]) : null;
      return String(val);
    },
    [primaryFieldName]
  );

  // Filter queue by search term (record ID, issue description, and cached display names)
  const filteredQueue = useMemo(() => {
    if (!currentQueueGroup) return [];
    const q = queueSearch.trim().toLowerCase();
    if (!q) return currentQueueGroup.records;
    return currentQueueGroup.records.filter((record) => {
      if (record.record_id.toLowerCase().includes(q)) return true;
      for (const issue of record.issues) {
        if (issue.description?.toLowerCase().includes(q)) return true;
        if (issue.rule_id?.toLowerCase().includes(q)) return true;
      }
      // Also check cached display name
      const cached = recordsCacheRef.current[record.record_id];
      if (cached) {
        const name = getDisplayNameFromRecord(cached);
        if (name && name.toLowerCase().includes(q)) return true;
      }
      return false;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentQueueGroup, queueSearch, recordsCacheVersion, getDisplayNameFromRecord]);

  const paginatedQueue = useMemo(() => {
    const start = queuePage * QUEUE_PAGE_SIZE;
    return filteredQueue.slice(start, start + QUEUE_PAGE_SIZE);
  }, [filteredQueue, queuePage]);

  const queueRecordIds = useMemo(
    () => paginatedQueue.map((r) => r.record_id),
    [paginatedQueue]
  );
  const { records: queueRecords } = useAirtableRecords(queueEntity, queueRecordIds);

  // Cache loaded records so name search works across pages
  useEffect(() => {
    const ids = Object.keys(queueRecords);
    if (ids.length === 0) return;
    let added = false;
    for (const [id, rec] of Object.entries(queueRecords)) {
      if (!recordsCacheRef.current[id]) {
        recordsCacheRef.current[id] = rec;
        added = true;
      }
    }
    if (added) setRecordsCacheVersion((v) => v + 1);
  }, [queueRecords]);

  /** Get the display name for a record by ID — checks current page records then cache. */
  const getRecordDisplayName = useCallback(
    (recordId: string): string | null => {
      const rec = queueRecords[recordId] || recordsCacheRef.current[recordId];
      return getDisplayNameFromRecord(rec);
    },
    [queueRecords, getDisplayNameFromRecord]
  );

  const handleRunChange = (runId: string) => {
    setSearchParams(runId ? { run_id: runId } : {}, { replace: false });
  };

  const handleGroupClick = (entity: string, issueType: string) => {
    setView({ view: "queue", entity, issueType });
  };

  const handleRecordAction = (record: EntityRecord, entity: string) => {
    const dupIssue = record.issues.find((i) => i.issue_type === "duplicate");
    if (dupIssue && dupIssue.related_records?.length) {
      setView({
        view: "merge",
        entity,
        primaryRecordId: record.record_id,
        secondaryRecordIds: dupIssue.related_records,
      });
    } else {
      setView({
        view: "edit",
        entity,
        recordId: record.record_id,
        issues: record.issues,
      });
    }
  };

  const handleBackToQueue = (entity: string, issueType: string) => {
    setView({ view: "queue", entity, issueType });
  };

  const handleBackToOverview = () => {
    setView({ view: "overview" });
  };

  // Render: Merge view
  if (viewState.view === "merge") {
    return (
      <div className="space-y-6">
        <div>
          <h1
            className="text-2xl font-semibold text-[var(--text-main)]"
            style={{ fontFamily: "Outfit" }}
          >
            Merge Duplicates
          </h1>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            Compare and merge duplicate {getEntityDisplayName(viewState.entity).toLowerCase()} records
          </p>
        </div>
        <DuplicateMergeView
          entity={viewState.entity}
          primaryRecordId={viewState.primaryRecordId}
          secondaryRecordIds={viewState.secondaryRecordIds}
          onBack={() => handleBackToQueue(viewState.entity, "duplicate")}
          onMergeComplete={async () => {
            // Resolve issues for all records involved in the merge
            const allRecordIds = [
              viewState.primaryRecordId,
              ...viewState.secondaryRecordIds,
            ];
            await resolveIssues(allRecordIds, viewState.entity);
            refetch();
            handleBackToQueue(viewState.entity, "duplicate");
          }}
        />
      </div>
    );
  }

  // Render: Edit view
  if (viewState.view === "edit") {
    return (
      <div className="space-y-6">
        <div>
          <h1
            className="text-2xl font-semibold text-[var(--text-main)]"
            style={{ fontFamily: "Outfit" }}
          >
            Edit Record
          </h1>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            Fix issues on this {getEntityDisplayName(viewState.entity).toLowerCase()} record
          </p>
        </div>
        <RecordEditor
          entity={viewState.entity}
          recordId={viewState.recordId}
          issues={viewState.issues}
          onBack={() =>
            handleBackToQueue(
              viewState.entity,
              viewState.issues[0]?.issue_type || "missing_field"
            )
          }
          onSaveComplete={async () => {
            // Resolve the specific issues that were fixed
            const ruleIds = viewState.issues.map((i) => i.rule_id).filter(Boolean);
            await resolveIssues(
              [viewState.recordId],
              viewState.entity,
              ruleIds.length > 0 ? ruleIds : undefined
            );
            refetch();
            handleBackToQueue(
              viewState.entity,
              viewState.issues[0]?.issue_type || "missing_field"
            );
          }}
        />
      </div>
    );
  }

  // Render: Queue view
  if (viewState.view === "queue" && currentQueueGroup) {
    const totalFiltered = filteredQueue.length;
    const totalPages = Math.ceil(totalFiltered / QUEUE_PAGE_SIZE);
    const startIndex = queuePage * QUEUE_PAGE_SIZE;
    const endIndex = startIndex + QUEUE_PAGE_SIZE;

    return (
      <div className="space-y-6">
        <div>
          <h1
            className="text-2xl font-semibold text-[var(--text-main)]"
            style={{ fontFamily: "Outfit" }}
          >
            {currentQueueGroup.displayEntity}{" "}
            {ISSUE_TYPE_LABELS[currentQueueGroup.issueType] ||
              currentQueueGroup.issueType}
          </h1>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            {currentQueueGroup.count} record{currentQueueGroup.count !== 1 ? "s" : ""} to review
          </p>
        </div>

        <button
          onClick={handleBackToOverview}
          className="text-sm text-[var(--cta-blue)] hover:underline flex items-center gap-1"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Back to overview
        </button>

        {/* Search bar */}
        <div className="relative">
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          <input
            type="text"
            value={queueSearch}
            onChange={(e) => {
              setQueueSearch(e.target.value);
              setQueuePage(0);
            }}
            placeholder="Search by name, record ID, or issue..."
            className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-[var(--border)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--cta-blue)] bg-white"
          />
          {queueSearch && (
            <button
              onClick={() => {
                setQueueSearch("");
                setQueuePage(0);
              }}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-main)]"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        {/* Results info when searching */}
        {queueSearch && (
          <p className="text-xs text-[var(--text-muted)]">
            {totalFiltered} result{totalFiltered !== 1 ? "s" : ""} matching "{queueSearch}"
          </p>
        )}

        <div className="rounded-2xl border border-[var(--border)] bg-white overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] bg-gray-50/50">
                <th className="px-5 py-3 text-left font-medium text-[var(--text-muted)]">
                  Name
                </th>
                <th className="px-5 py-3 text-left font-medium text-[var(--text-muted)]">
                  Record ID
                </th>
                <th className="px-5 py-3 text-left font-medium text-[var(--text-muted)]">
                  Issue
                </th>
                <th className="px-5 py-3 text-left font-medium text-[var(--text-muted)]">
                  Severity
                </th>
                {currentQueueGroup.issueType === "duplicate" && (
                  <th className="px-5 py-3 text-left font-medium text-[var(--text-muted)]">
                    Related
                  </th>
                )}
                <th className="px-5 py-3 text-right font-medium text-[var(--text-muted)]">
                  Action
                </th>
              </tr>
            </thead>
            <tbody>
              {paginatedQueue.length === 0 ? (
                <tr>
                  <td
                    colSpan={currentQueueGroup.issueType === "duplicate" ? 6 : 5}
                    className="px-5 py-8 text-center text-sm text-[var(--text-muted)]"
                  >
                    {queueSearch
                      ? "No records match your search."
                      : "No records in this group."}
                  </td>
                </tr>
              ) : (
                paginatedQueue.map((record) => {
                  const mainIssue =
                    record.issues.find(
                      (i) => i.issue_type === currentQueueGroup.issueType
                    ) || record.issues[0];
                  const dupIssue = record.issues.find(
                    (i) => i.issue_type === "duplicate"
                  );
                  const displayName = getRecordDisplayName(record.record_id);
                  return (
                    <tr
                      key={record.record_id}
                      className="border-b border-[var(--border)] last:border-0 hover:bg-gray-50/50"
                    >
                      <td className="px-5 py-3">
                        <span className="text-sm font-medium text-[var(--text-main)]">
                          {displayName || (
                            <span className="text-[var(--text-muted)] italic text-xs">Loading...</span>
                          )}
                        </span>
                      </td>
                      <td className="px-5 py-3">
                        <code className="text-xs font-mono text-[var(--text-muted)]">
                          {record.record_id}
                        </code>
                      </td>
                      <td className="px-5 py-3 text-xs text-[var(--text-muted)] max-w-[300px] truncate">
                        {mainIssue?.description || mainIssue?.rule_id || "—"}
                      </td>
                      <td className="px-5 py-3">
                        <span
                          className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${getSeverityColor(
                            mainIssue?.severity || "info"
                          )}`}
                        >
                          {mainIssue?.severity || "info"}
                        </span>
                      </td>
                      {currentQueueGroup.issueType === "duplicate" && (
                        <td className="px-5 py-3 text-xs text-[var(--text-muted)]">
                          {dupIssue?.related_records?.length || 0} duplicate
                          {(dupIssue?.related_records?.length || 0) !== 1
                            ? "s"
                            : ""}
                        </td>
                      )}
                      <td className="px-5 py-3 text-right">
                        <button
                          onClick={() =>
                            handleRecordAction(
                              record,
                              currentQueueGroup.entity
                            )
                          }
                          className="rounded-lg bg-[var(--brand)] px-3 py-1 text-xs font-medium text-white hover:opacity-90 transition-colors"
                        >
                          {currentQueueGroup.issueType === "duplicate"
                            ? "Review"
                            : "Edit"}
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <Pagination
          currentPage={queuePage + 1}
          totalPages={totalPages}
          totalItems={totalFiltered}
          itemsPerPage={QUEUE_PAGE_SIZE}
          startIndex={startIndex}
          endIndex={endIndex}
          onPageChange={(page) => setQueuePage(page - 1)}
          itemLabel="records"
        />
      </div>
    );
  }

  // Render: Overview (default)
  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1
          className="text-3xl font-semibold text-[var(--text-main)]"
          style={{ fontFamily: "Outfit" }}
        >
          Remediate
        </h1>
        <p className="mt-1 text-[var(--text-muted)]">
          Review and fix data integrity issues directly in Airtable
        </p>
      </div>

      {/* Run Selector */}
      <div className="rounded-2xl border border-[var(--border)] bg-white p-5">
        <label className="block text-sm font-medium text-[var(--text-main)] mb-2">
          Select a completed scan run
        </label>
        <div className="flex gap-3 items-end">
          <select
            value={selectedRunId || ""}
            onChange={(e) => handleRunChange(e.target.value)}
            className="flex-1 rounded-lg border border-[var(--border)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--cta-blue)]"
          >
            <option value="">Choose a run...</option>
            {runsLoading && <option disabled>Loading runs...</option>}
            {completedRuns.map((run) => (
              <option key={run.id} value={run.id}>
                {run.time} — {run.status} — {run.anomalies} issues (
                {run.trigger})
              </option>
            ))}
          </select>
          {selectedRunId && (
            <button
              onClick={() => navigate(`/run/${selectedRunId}`)}
              className="rounded-lg border border-[var(--border)] px-4 py-2 text-sm font-medium text-[var(--text-main)] hover:bg-gray-50 transition-colors"
            >
              View Run
            </button>
          )}
        </div>
      </div>

      {/* Loading */}
      {dataLoading && (
        <div className="rounded-2xl border border-[var(--border)] bg-white p-8 text-center">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--brand)] mb-4" />
          <p className="text-[var(--text-muted)]">Loading issue data...</p>
        </div>
      )}

      {/* Error */}
      {dataError && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {dataError}
        </div>
      )}

      {/* Summary stats */}
      {recordIdsData && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="rounded-2xl border border-[var(--border)] bg-white p-4">
            <p className="text-sm text-[var(--text-muted)]">Total Records</p>
            <p
              className="text-2xl font-semibold text-[var(--text-main)] mt-1"
              style={{ fontFamily: "Outfit" }}
            >
              {recordIdsData.total_records}
            </p>
          </div>
          <div className="rounded-2xl border border-[var(--border)] bg-white p-4">
            <p className="text-sm text-[var(--text-muted)]">Total Issues</p>
            <p
              className="text-2xl font-semibold text-[var(--text-main)] mt-1"
              style={{ fontFamily: "Outfit" }}
            >
              {recordIdsData.total_issues}
            </p>
          </div>
          <div className="rounded-2xl border border-[var(--border)] bg-white p-4">
            <p className="text-sm text-[var(--text-muted)]">Entities</p>
            <p
              className="text-2xl font-semibold text-[var(--text-main)] mt-1"
              style={{ fontFamily: "Outfit" }}
            >
              {Object.keys(recordIdsData.entities).length}
            </p>
          </div>
          <div className="rounded-2xl border border-[var(--border)] bg-white p-4">
            <p className="text-sm text-[var(--text-muted)]">Issue Groups</p>
            <p
              className="text-2xl font-semibold text-[var(--text-main)] mt-1"
              style={{ fontFamily: "Outfit" }}
            >
              {issueGroups.length}
            </p>
          </div>
        </div>
      )}

      {/* Issue Groups */}
      {issueGroups.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {issueGroups.map((group) => (
            <button
              key={`${group.entity}:${group.issueType}`}
              onClick={() => handleGroupClick(group.entity, group.issueType)}
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
                          ISSUE_TYPE_ICONS[group.issueType] ||
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
                      {group.displayEntity}{" "}
                      {ISSUE_TYPE_LABELS[group.issueType] || group.issueType}
                    </h3>
                    <p className="text-xs text-[var(--text-muted)] mt-0.5">
                      {group.count} record{group.count !== 1 ? "s" : ""} to
                      review
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
              {/* Severity badges */}
              <div className="flex gap-2 mt-3">
                {Object.entries(group.severityCounts)
                  .sort(([a], [b]) => {
                    const order = { critical: 0, warning: 1, info: 2 };
                    return (
                      (order[a as keyof typeof order] ?? 3) -
                      (order[b as keyof typeof order] ?? 3)
                    );
                  })
                  .map(([severity, count]) => (
                    <span
                      key={severity}
                      className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${getSeverityColor(
                        severity
                      )}`}
                    >
                      {count} {severity}
                    </span>
                  ))}
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Empty state */}
      {selectedRunId && !dataLoading && !dataError && issueGroups.length === 0 && (
        <div className="rounded-2xl border border-[var(--border)] bg-white p-8 text-center">
          <p className="text-[var(--text-muted)]">
            No issues found for this run. The scan may have completed with no
            issues, or the data may not be available.
          </p>
        </div>
      )}

      {/* No run selected */}
      {!selectedRunId && !dataLoading && (
        <div className="rounded-2xl border border-[var(--border)] bg-white p-8 text-center">
          <svg
            className="w-12 h-12 text-[var(--text-muted)] mx-auto mb-3 opacity-50"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"
            />
          </svg>
          <p className="text-[var(--text-muted)]">
            Select a completed scan run to start remediating issues.
          </p>
        </div>
      )}
    </div>
  );
}
