import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useCategoryQueue } from "../hooks/useCategoryQueue";
import { useAirtableRecords } from "../hooks/useAirtableRecords";
import { useAirtableSchema } from "../contexts/AirtableSchemaContext";
import {
  normalizeEntityName,
  getEntityDisplayName,
} from "../config/entities";
import { Pagination } from "../components/Pagination";
import type { EntityRecord } from "../hooks/useRunRecordIds";

const QUEUE_PAGE_SIZE = 20;

const ISSUE_TYPE_LABELS: Record<string, string> = {
  duplicate: "Duplicates",
  missing_field: "Missing Fields",
  missing_link: "Missing Links",
  relationship: "Relationship Issues",
  attendance: "Attendance Issues",
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

export function CategoryQueuePage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const entity = searchParams.get("entity") || "";
  const issueType = searchParams.get("type") || "";

  const normalizedEntity = normalizeEntityName(entity);
  const displayEntity = getEntityDisplayName(entity);
  const issueTypeLabel =
    ISSUE_TYPE_LABELS[issueType] || issueType;

  // Use raw entity from URL for Firestore query (matches stored values)
  const { records, totalRecords, loading, error, refetch } =
    useCategoryQueue(entity || null, issueType || null);

  const [queueSearch, setQueueSearch] = useState("");
  const [queuePage, setQueuePage] = useState(0);

  const { schema } = useAirtableSchema();
  const recordsCacheRef = useRef<Record<string, any>>({});
  const [recordsCacheVersion, setRecordsCacheVersion] = useState(0);

  const primaryFieldName = useMemo(() => {
    if (!schema?.tables || !normalizedEntity) return null;
    for (const table of schema.tables) {
      const tableName = table.name?.toLowerCase().replace(/ /g, "_");
      if (
        tableName === normalizedEntity ||
        normalizedEntity.includes(tableName) ||
        tableName?.includes(normalizedEntity)
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
  }, [schema, normalizedEntity]);

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

  const filteredQueue = useMemo(() => {
    const q = queueSearch.trim().toLowerCase();
    if (!q) return records;
    return records.filter((record) => {
      if (record.record_id.toLowerCase().includes(q)) return true;
      for (const issue of record.issues) {
        if (issue.description?.toLowerCase().includes(q)) return true;
        if (issue.rule_id?.toLowerCase().includes(q)) return true;
      }
      const cached = recordsCacheRef.current[record.record_id];
      if (cached) {
        const name = getDisplayNameFromRecord(cached);
        if (name && name.toLowerCase().includes(q)) return true;
      }
      return false;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [records, queueSearch, recordsCacheVersion, getDisplayNameFromRecord]);

  const paginatedQueue = useMemo(() => {
    const start = queuePage * QUEUE_PAGE_SIZE;
    return filteredQueue.slice(start, start + QUEUE_PAGE_SIZE);
  }, [filteredQueue, queuePage]);

  const queueRecordIds = useMemo(
    () => paginatedQueue.map((r) => r.record_id),
    [paginatedQueue]
  );
  const { records: queueRecords } = useAirtableRecords(
    normalizedEntity || undefined,
    queueRecordIds
  );

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

  const getRecordDisplayName = useCallback(
    (recordId: string): string | null => {
      const rec = queueRecords[recordId] || recordsCacheRef.current[recordId];
      return getDisplayNameFromRecord(rec);
    },
    [queueRecords, getDisplayNameFromRecord]
  );

  const handleRecordAction = (record: EntityRecord) => {
    const dupIssue = record.issues.find((i) => i.issue_type === "duplicate");
    if (dupIssue && dupIssue.related_records?.length) {
      const params = new URLSearchParams({
        entity: entity,
        record_id: record.record_id,
        view: "merge",
        from_entity: entity,
        from_type: issueType,
      });
      dupIssue.related_records.forEach((rid) =>
        params.append("related_record", rid)
      );
      if (dupIssue.severity) params.set("severity", dupIssue.severity);
      if (dupIssue.description)
        params.set("description", dupIssue.description);
      if (dupIssue.rule_id) params.set("rule_id", dupIssue.rule_id);
      navigate(`/issues/fix?${params.toString()}`);
    } else {
      const params = new URLSearchParams({
        entity: entity,
        record_id: record.record_id,
        view: "edit",
        from_entity: entity,
        from_type: issueType,
      });
      navigate(`/issues/fix?${params.toString()}`);
    }
  };

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
          {displayEntity} {issueTypeLabel}
        </h1>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          {totalRecords} record{totalRecords !== 1 ? "s" : ""} to review
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
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        )}
      </div>

      {queueSearch && (
        <p className="text-xs text-[var(--text-muted)]">
          {totalFiltered} result{totalFiltered !== 1 ? "s" : ""} matching "
          {queueSearch}"
        </p>
      )}

      {loading && (
        <div className="rounded-2xl border border-[var(--border)] bg-white p-8 text-center">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--brand)] mb-4" />
          <p className="text-[var(--text-muted)]">Loading records...</p>
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {error}
        </div>
      )}

      {!loading && !error && (
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
                {issueType === "duplicate" && (
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
                    colSpan={issueType === "duplicate" ? 6 : 5}
                    className="px-5 py-8 text-center text-sm text-[var(--text-muted)]"
                  >
                    {queueSearch
                      ? "No records match your search."
                      : "No records in this category."}
                  </td>
                </tr>
              ) : (
                paginatedQueue.map((record) => {
                  const mainIssue =
                    record.issues.find(
                      (i) => i.issue_type === issueType
                    ) || record.issues[0];
                  const displayName = getRecordDisplayName(record.record_id);
                  return (
                    <tr
                      key={record.record_id}
                      className="border-b border-[var(--border)] last:border-0 hover:bg-gray-50/50 transition-colors"
                    >
                      <td className="px-5 py-3">
                        <span className="text-sm font-medium text-[var(--text-main)]">
                          {displayName || (
                            <span className="text-[var(--text-muted)] italic">
                              Loading...
                            </span>
                          )}
                        </span>
                      </td>
                      <td className="px-5 py-3 font-mono text-xs text-[var(--text-muted)]">
                        {record.record_id}
                      </td>
                      <td className="px-5 py-3 text-xs text-[var(--text-main)] max-w-[250px] truncate">
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
                      {issueType === "duplicate" && (
                        <td className="px-5 py-3 text-xs text-[var(--text-muted)]">
                          {mainIssue?.related_records?.length || 0} record
                          {(mainIssue?.related_records?.length || 0) !== 1
                            ? "s"
                            : ""}
                        </td>
                      )}
                      <td className="px-5 py-3 text-right">
                        <button
                          onClick={() => handleRecordAction(record)}
                          className="rounded-lg bg-[var(--brand)] px-3 py-1 text-xs font-medium text-white hover:opacity-90 transition-colors"
                        >
                          Fix
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}

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
