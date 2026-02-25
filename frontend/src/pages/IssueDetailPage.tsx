import { useEffect, useState, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  doc,
  getDoc,
  collection,
  query,
  where,
  getDocs,
} from "firebase/firestore";
import { db } from "../config/firebase";
import type { Issue } from "../hooks/useFirestoreIssues";
import { getAirtableLinksWithFallback } from "../utils/airtable";
import { formatRuleId } from "../utils/ruleFormatter";
import { useIssueActions } from "../hooks/useIssueActions";
import { useAuth } from "../hooks/useAuth";
import { useAirtableSchema } from "../contexts/AirtableSchemaContext";
import { useAirtableRecords } from "../hooks/useAirtableRecords";
import ConfirmModal from "../components/ConfirmModal";
import { AirtableRecordCards } from "../components/AirtableRecordCard";
import openInNewTabIcon from "../assets/open_in_new_tab.svg";

export function IssueDetailPage() {
  const { issueId } = useParams<{ issueId: string }>();
  const navigate = useNavigate();
  const [issue, setIssue] = useState<Issue | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [relatedIssues, setRelatedIssues] = useState<Issue[]>([]);
  const [loadingRelated, setLoadingRelated] = useState(false);
  const {
    markResolved,
    deleteIssue,
    loading: actionLoading,
  } = useIssueActions();
  const { isAdmin } = useAuth();
  const { schema } = useAirtableSchema();
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmModal, setConfirmModal] = useState<{
    isOpen: boolean;
    action: "resolve" | "delete" | null;
  }>({
    isOpen: false,
    action: null,
  });

  useEffect(() => {
    if (!issueId) {
      setError("Issue ID is required");
      setLoading(false);
      return;
    }

    const fetchIssue = async () => {
      try {
        const issueRef = doc(db, "integrity_issues", issueId);
        const issueSnap = await getDoc(issueRef);

        if (!issueSnap.exists()) {
          setError("Issue not found");
          setLoading(false);
          return;
        }

        const data = issueSnap.data();
        const issueData: Issue = {
          id: issueSnap.id,
          rule_id: data.rule_id || "",
          entity: data.entity || "",
          record_id: data.record_id || "",
          severity: data.severity || "info",
          issue_type: data.issue_type || "",
          description: data.description,
          metadata: data.metadata,
          related_records: data.related_records || [],
          created_at: data.created_at?.toDate?.() || new Date(),
          updated_at: data.updated_at?.toDate?.() || new Date(),
          status: data.status || "open",
          run_id: data.run_id,
        };

        setIssue(issueData);
        setLoading(false);

        // If this is a duplicate issue, fetch related duplicate issues
        if (issueData.issue_type === "duplicate" && issueData.rule_id) {
          fetchRelatedDuplicateIssues(issueData);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load issue");
        setLoading(false);
      }
    };

    fetchIssue();
  }, [issueId]);

  // Collect all unique duplicate record IDs from current issue and related issues
  // Must be called before conditional returns to follow Rules of Hooks
  const allDuplicateRecords = useMemo(() => {
    if (!issue) return [];

    const records = new Set<string>();

    // Add current record
    records.add(issue.record_id);

    // Add related records from current issue
    const relatedRecords = issue.related_records || [];
    relatedRecords.forEach((id) => records.add(id));

    // Add records from related duplicate issues
    relatedIssues.forEach((relatedIssue) => {
      records.add(relatedIssue.record_id);
      if (relatedIssue.related_records) {
        relatedIssue.related_records.forEach((id) => records.add(id));
      }
    });

    return Array.from(records);
  }, [issue, relatedIssues]);

  // Determine which record IDs to fetch for the record cards
  // For duplicates: fetch first 2 records (side-by-side display)
  // For attendance duplicate absences: fetch both the duplicate and primary records
  // For other issues: fetch just the primary record
  const recordIdsToFetch = useMemo(() => {
    if (!issue) return [];

    if (issue.issue_type === "duplicate") {
      // For duplicates, show the current record and first related record (if any)
      const ids = [issue.record_id];
      if (issue.related_records && issue.related_records.length > 0) {
        ids.push(issue.related_records[0]);
      }
      return ids.slice(0, 2); // Max 2 for side-by-side
    }

    // For attendance duplicate absences, show both the duplicate record and primary record
    if (
      issue.issue_type === "attendance" &&
      issue.rule_id === "attendance.duplicate_absence" &&
      issue.metadata?.primary_record_id
    ) {
      // Show the duplicate record (current) and the primary record
      return [issue.record_id, issue.metadata.primary_record_id];
    }

    // For non-duplicate issues, just fetch the primary record
    return [issue.record_id];
  }, [issue]);

  // Fetch Airtable record data
  const {
    records: airtableRecords,
    loading: recordsLoading,
    error: recordsError,
  } = useAirtableRecords(issue?.entity, recordIdsToFetch);

  const fetchRelatedDuplicateIssues = async (currentIssue: Issue) => {
    if (!currentIssue.rule_id || currentIssue.issue_type !== "duplicate") {
      return;
    }

    setLoadingRelated(true);
    try {
      // Find all issues with the same rule_id and entity that involve the same records
      const issuesRef = collection(db, "integrity_issues");
      const q = query(
        issuesRef,
        where("rule_id", "==", currentIssue.rule_id),
        where("entity", "==", currentIssue.entity),
        where("issue_type", "==", "duplicate"),
        where("status", "==", "open")
      );

      const snapshot = await getDocs(q);
      const related: Issue[] = [];

      snapshot.forEach((doc) => {
        const data = doc.data();
        // Include issues that share the same record_id or have this record in their related_records
        const isRelated =
          data.record_id === currentIssue.record_id ||
          (data.related_records &&
            data.related_records.includes(currentIssue.record_id)) ||
          (currentIssue.related_records &&
            currentIssue.related_records.includes(data.record_id));

        if (isRelated && doc.id !== currentIssue.id) {
          related.push({
            id: doc.id,
            rule_id: data.rule_id || "",
            entity: data.entity || "",
            record_id: data.record_id || "",
            severity: data.severity || "info",
            issue_type: data.issue_type || "",
            description: data.description,
            metadata: data.metadata,
            related_records: data.related_records || [],
            created_at: data.created_at?.toDate?.() || new Date(),
            updated_at: data.updated_at?.toDate?.() || new Date(),
            status: data.status || "open",
          });
        }
      });

      setRelatedIssues(related);
    } catch (err) {
      console.error("Failed to fetch related duplicate issues:", err);
    } finally {
      setLoadingRelated(false);
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

    if (diffDays > 0) return `${diffDays} day${diffDays > 1 ? "s" : ""} ago`;
    if (diffHours > 0)
      return `${diffHours} hour${diffHours > 1 ? "s" : ""} ago`;
    if (diffMinutes > 0)
      return `${diffMinutes} minute${diffMinutes > 1 ? "s" : ""} ago`;
    return "Just now";
  };

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

  const getIssueTypeLabel = (type: string) => {
    switch (type) {
      case "duplicate":
        return "Duplicate Record";
      case "missing_link":
        return "Missing Link";
      case "missing_field":
        return "Missing Field";
      case "attendance":
        return "Attendance Anomaly";
      case "orphaned_link":
        return "Orphaned Link";
      default:
        return type;
    }
  };

  const handleResolve = async () => {
    if (!issue) return;
    setConfirmModal({ isOpen: false, action: null });
    setResolvingId(issue.id);
    try {
      await markResolved(issue.id);
      navigate(-1);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to resolve issue");
    } finally {
      setResolvingId(null);
    }
  };

  const handleDelete = async () => {
    if (!issue) return;
    setConfirmModal({ isOpen: false, action: null });
    setDeletingId(issue.id);
    try {
      await deleteIssue(issue.id);
      navigate(-1);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to delete issue");
    } finally {
      setDeletingId(null);
    }
  };

  if (loading) {
    return (
      <div className="text-center py-12">
        <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--brand)] mb-4"></div>
        <p className="text-[var(--text-muted)]">Loading issue details...</p>
      </div>
    );
  }

  if (error || !issue) {
    return (
      <div className="rounded-lg bg-red-50 border border-red-200 px-6 py-4">
        <p className="text-red-700">{error || "Issue not found"}</p>
        <button
          onClick={() => navigate(-1)}
          className="mt-4 text-sm text-red-600 hover:text-red-800 underline"
        >
          ← Back
        </button>
      </div>
    );
  }

  const airtableLinks = issue
    ? getAirtableLinksWithFallback(issue.entity, issue.record_id, schema)
    : { primary: "https://airtable.com" };
  const relatedRecords = issue?.related_records || [];
  const metadata = issue?.metadata || {};

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <button
          onClick={() => navigate(-1)}
          className="text-sm text-[var(--text-muted)] hover:text-[var(--text-main)]"
        >
          ← Back
        </button>
        <div className="flex gap-2">
          {issue.run_id && (
            <button
              onClick={() => {
                const params = new URLSearchParams({
                  run_id: issue.run_id!,
                  entity: issue.entity,
                  record_id: issue.record_id,
                });
                if (issue.issue_type === "duplicate" && issue.related_records?.length) {
                  params.set("view", "merge");
                  issue.related_records.forEach((rid) => params.append("related_record", rid));
                } else {
                  params.set("view", "edit");
                }
                navigate(`/remediate?${params.toString()}`);
              }}
              className="px-4 py-2 text-sm font-medium text-[var(--brand)] border border-[var(--brand)] hover:bg-[var(--brand)]/10 rounded-lg transition-colors"
            >
              Remediate
            </button>
          )}
          {isAdmin && (
            <>
              <button
                onClick={() =>
                  setConfirmModal({ isOpen: true, action: "resolve" })
                }
                disabled={actionLoading && resolvingId === issue.id}
                className="px-4 py-2 text-sm font-medium text-[var(--text-main)] bg-[var(--bg-mid)] hover:bg-[var(--bg-mid)]/80 rounded-lg disabled:opacity-50"
              >
                {actionLoading && resolvingId === issue.id ? "..." : "Resolve"}
              </button>
              <button
                onClick={() =>
                  setConfirmModal({ isOpen: true, action: "delete" })
                }
                disabled={deletingId === issue.id}
                className="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg disabled:opacity-50"
              >
                {deletingId === issue.id ? "..." : "Delete"}
              </button>
            </>
          )}
        </div>
      </div>

      <div className="rounded-3xl border border-[var(--border)] bg-white p-6 space-y-6">
        <div>
          <h1
            className="text-2xl font-semibold text-[var(--text-main)] mb-2"
            style={{ fontFamily: "Outfit" }}
          >
            Issue Details
          </h1>
          <div className="flex items-center gap-3 mt-4">
            <span
              className={`rounded-full px-3 py-1 text-sm font-medium uppercase tracking-wide ${getSeverityColor(
                issue.severity
              )}`}
            >
              {issue.severity}
            </span>
            <span className="text-sm text-[var(--text-muted)]">
              {getIssueTypeLabel(issue.issue_type)}
            </span>
            <span className="text-sm text-[var(--text-muted)]">
              • {formatAge(issue.created_at)}
            </span>
          </div>
        </div>

        <div className="grid gap-6 md:grid-cols-2">
          <div className="space-y-4">
            <div>
              <h3 className="text-sm font-medium text-[var(--text-muted)] mb-2">
                Rule
              </h3>
              <p
                className="text-sm text-[var(--text-main)]"
                title={issue.rule_id}
              >
                {formatRuleId(issue.rule_id)}
              </p>
            </div>

            <div>
              <h3 className="text-sm font-medium text-[var(--text-muted)] mb-2">
                Entity
              </h3>
              <p className="text-sm text-[var(--text-main)] capitalize">
                {issue.entity}
              </p>
            </div>

            <div>
              <h3 className="text-sm font-medium text-[var(--text-muted)] mb-2">
                Record ID
              </h3>
              <a
                href={airtableLinks?.primary || `https://airtable.com`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-sm text-[var(--cta-blue)] hover:underline inline-flex items-center gap-1"
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
            </div>
          </div>

          <div className="space-y-4">
            <div>
              <h3 className="text-sm font-medium text-[var(--text-muted)] mb-2">
                Description
              </h3>
              <p className="text-sm text-[var(--text-main)]">
                {issue.description || "No description available"}
              </p>
            </div>

            <div>
              <h3 className="text-sm font-medium text-[var(--text-muted)] mb-2">
                Status
              </h3>
              <span
                className={`inline-block rounded-full px-3 py-1 text-sm font-medium ${
                  issue.status === "open"
                    ? "bg-yellow-100 text-yellow-800"
                    : "bg-green-100 text-green-800"
                }`}
              >
                {issue.status || "open"}
              </span>
            </div>

            <div>
              <h3 className="text-sm font-medium text-[var(--text-muted)] mb-2">
                Created
              </h3>
              <p className="text-sm text-[var(--text-main)]">
                {issue.created_at?.toLocaleString() || "Unknown"}
              </p>
            </div>
          </div>
        </div>

        {issue.issue_type === "duplicate" && (
          <div>
            <h3 className="text-sm font-medium text-[var(--text-muted)] mb-3">
              Duplicate Records ({allDuplicateRecords.length} total)
            </h3>
            <div className="space-y-2">
              {allDuplicateRecords.map((recordId: string, idx: number) => {
                const isCurrentRecord = recordId === issue.record_id;
                const recordLinks = getAirtableLinksWithFallback(
                  issue.entity,
                  recordId,
                  schema
                );
                return (
                  <div
                    key={recordId}
                    className={`rounded-lg border p-3 flex items-center justify-between ${
                      isCurrentRecord
                        ? "border-2 border-[var(--brand)] bg-[var(--brand)]/5"
                        : "border border-[var(--border)] bg-[var(--bg-mid)]/50"
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      {isCurrentRecord ? (
                        <span className="text-sm font-medium text-[var(--brand)]">
                          Current Record
                        </span>
                      ) : (
                        <span className="text-sm text-[var(--text-muted)]">
                          Duplicate #{idx}
                        </span>
                      )}
                      <a
                        href={recordLinks?.primary || `https://airtable.com`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-mono text-sm text-[var(--cta-blue)] hover:underline inline-flex items-center gap-1"
                      >
                        {recordId}
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
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Related duplicate issues section */}
            {loadingRelated && (
              <div className="mt-4 text-center py-4 text-sm text-[var(--text-muted)]">
                Loading related duplicate issues...
              </div>
            )}
            {!loadingRelated && relatedIssues.length > 0 && (
              <div className="mt-6 pt-6 border-t border-[var(--border)]">
                <h4 className="text-xs font-medium text-[var(--text-muted)] mb-3 uppercase tracking-wide">
                  Related Duplicate Issues ({relatedIssues.length})
                </h4>
                <p className="text-xs text-[var(--text-muted)] mb-3">
                  Other issues in the same duplicate group
                </p>
                <div className="space-y-2">
                  {relatedIssues.map((relatedIssue) => {
                    const relatedLinks = getAirtableLinksWithFallback(
                      relatedIssue.entity,
                      relatedIssue.record_id,
                      schema
                    );
                    return (
                      <div
                        key={relatedIssue.id}
                        className="rounded-lg border border-[var(--border)] bg-white p-3"
                      >
                        <div className="flex items-center justify-between mb-2">
                          <a
                            href={`/issue/${relatedIssue.id}`}
                            className="text-sm font-medium text-[var(--cta-blue)] hover:underline"
                          >
                            View Issue →
                          </a>
                          <span
                            className={`text-xs px-2 py-0.5 rounded-full ${
                              relatedIssue.severity === "critical"
                                ? "bg-red-100 text-red-800"
                                : relatedIssue.severity === "warning"
                                ? "bg-yellow-100 text-yellow-800"
                                : "bg-blue-100 text-blue-800"
                            }`}
                          >
                            {relatedIssue.severity}
                          </span>
                        </div>
                        <div className="text-xs text-[var(--text-muted)] mb-1">
                          {formatRuleId(relatedIssue.rule_id)}
                        </div>
                        <a
                          href={relatedLinks?.primary || `https://airtable.com`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-mono text-xs text-[var(--cta-blue)] hover:underline inline-flex items-center gap-1"
                        >
                          {relatedIssue.record_id}
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
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {issue.issue_type === "attendance" &&
          issue.rule_id === "attendance.duplicate_absence" &&
          metadata?.primary_record_id && (
            <div>
              <h3 className="text-sm font-medium text-[var(--text-muted)] mb-3">
                Duplicate Absence Records (2 total)
              </h3>
              <div className="space-y-2">
                {/* Show the duplicate record that triggered the flag */}
                {(() => {
                  const duplicateRecordId = issue.record_id;
                  const duplicateRecordLinks = getAirtableLinksWithFallback(
                    issue.entity,
                    duplicateRecordId,
                    schema
                  );
                  return (
                    <div className="rounded-lg border-2 border-[var(--brand)] bg-[var(--brand)]/5 p-3 flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <span className="text-sm font-medium text-[var(--brand)]">
                          Duplicate Record (Flagged)
                        </span>
                        <a
                          href={
                            duplicateRecordLinks?.primary ||
                            `https://airtable.com`
                          }
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-mono text-sm text-[var(--cta-blue)] hover:underline inline-flex items-center gap-1"
                        >
                          {duplicateRecordId}
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
                      </div>
                    </div>
                  );
                })()}
                {/* Show the primary record */}
                {(() => {
                  const primaryRecordId = metadata.primary_record_id;
                  const primaryRecordLinks = getAirtableLinksWithFallback(
                    issue.entity,
                    primaryRecordId,
                    schema
                  );
                  return (
                    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-mid)]/50 p-3 flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <span className="text-sm text-[var(--text-muted)]">
                          Primary Record
                        </span>
                        <a
                          href={
                            primaryRecordLinks?.primary ||
                            `https://airtable.com`
                          }
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-mono text-sm text-[var(--cta-blue)] hover:underline inline-flex items-center gap-1"
                        >
                          {primaryRecordId}
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
                      </div>
                    </div>
                  );
                })()}
              </div>
            </div>
          )}

        {issue.issue_type === "missing_link" && metadata && (
          <div>
            <h3 className="text-sm font-medium text-[var(--text-muted)] mb-3">
              Link Details
            </h3>
            <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-mid)]/50 p-4 space-y-2">
              {metadata.target_entity && (
                <div>
                  <span className="text-sm font-medium text-[var(--text-muted)]">
                    Target Entity:{" "}
                  </span>
                  <span className="text-sm text-[var(--text-main)] capitalize">
                    {metadata.target_entity}
                  </span>
                </div>
              )}
              {metadata.relationship && (
                <div>
                  <span className="text-sm font-medium text-[var(--text-muted)]">
                    Relationship:{" "}
                  </span>
                  <span className="text-sm text-[var(--text-main)]">
                    {metadata.relationship}
                  </span>
                </div>
              )}
              {metadata.orphaned_id && (
                <div>
                  <span className="text-sm font-medium text-[var(--text-muted)]">
                    Orphaned Record ID:{" "}
                  </span>
                  <span className="font-mono text-sm text-[var(--text-main)]">
                    {metadata.orphaned_id}
                  </span>
                </div>
              )}
              {metadata.actual !== undefined && (
                <div>
                  <span className="text-sm font-medium text-[var(--text-muted)]">
                    Actual Links:{" "}
                  </span>
                  <span className="text-sm text-[var(--text-main)]">
                    {metadata.actual}
                  </span>
                </div>
              )}
              {metadata.expected_min !== undefined && (
                <div>
                  <span className="text-sm font-medium text-[var(--text-muted)]">
                    Expected Minimum:{" "}
                  </span>
                  <span className="text-sm text-[var(--text-main)]">
                    {metadata.expected_min}
                  </span>
                </div>
              )}
            </div>
          </div>
        )}

        {issue.issue_type === "missing_field" && metadata && (
          <div>
            <h3 className="text-sm font-medium text-[var(--text-muted)] mb-3">
              Missing Field Details
            </h3>
            <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-mid)]/50 p-4">
              {metadata.field_name && (
                <div>
                  <span className="text-sm font-medium text-[var(--text-muted)]">
                    Field Name:{" "}
                  </span>
                  <span className="text-sm text-[var(--text-main)]">
                    {metadata.field_name}
                  </span>
                </div>
              )}
            </div>
          </div>
        )}

        {Object.keys(metadata).length > 0 && (
          <div>
            <h3 className="text-sm font-medium text-[var(--text-muted)] mb-3">
              Additional Metadata
            </h3>
            <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-mid)]/50 p-4">
              <pre className="text-xs text-[var(--text-main)] overflow-auto">
                {JSON.stringify(metadata, null, 2)}
              </pre>
            </div>
          </div>
        )}
      </div>

      {/* Airtable Record Data Cards */}
      {issue && recordIdsToFetch.length > 0 && (
        <AirtableRecordCards
          records={airtableRecords}
          entity={issue.entity}
          recordIds={recordIdsToFetch}
          currentRecordId={issue.record_id}
          loading={recordsLoading}
          error={recordsError}
        />
      )}

      <ConfirmModal
        isOpen={confirmModal.isOpen && confirmModal.action === "resolve"}
        title="Resolve Issue"
        message="Are you sure you want to mark this issue as resolved? This will update the status in Firestore."
        confirmLabel="Resolve"
        onConfirm={handleResolve}
        onCancel={() => setConfirmModal({ isOpen: false, action: null })}
      />
      <ConfirmModal
        isOpen={confirmModal.isOpen && confirmModal.action === "delete"}
        title="Delete Issue"
        message="Are you sure you want to delete this issue? This action cannot be undone and will permanently remove the issue from Firebase."
        confirmLabel="Delete"
        isDestructive
        onConfirm={handleDelete}
        onCancel={() => setConfirmModal({ isOpen: false, action: null })}
      />
    </div>
  );
}
