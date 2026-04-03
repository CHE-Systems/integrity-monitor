import { useState, useMemo, useEffect, useCallback } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { DuplicateMergeView } from "../components/DuplicateMergeView";
import { RecordEditor } from "../components/RecordEditor";
import { useRemediateActions } from "../hooks/useRemediateActions";
import {
  collection,
  query,
  where,
  getDocs,
} from "firebase/firestore";
import { db } from "../config/firebase";
import {
  normalizeEntityName,
  getEntityDisplayName,
} from "../config/entities";
import type { RecordIssue } from "../hooks/useRunRecordIds";

const ISSUE_TYPE_LABELS: Record<string, string> = {
  duplicate: "Duplicates",
  missing_field: "Missing Fields",
  missing_link: "Missing Links",
  relationship: "Relationship Issues",
  attendance: "Attendance Issues",
};

export function RemediationPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { resolveIssues } = useRemediateActions();

  const entity = searchParams.get("entity") || "";
  const recordId = searchParams.get("record_id") || "";
  const view = searchParams.get("view") || "edit";
  const relatedRecords = searchParams.getAll("related_record");
  const severity = searchParams.get("severity") || undefined;
  const description = searchParams.get("description") || undefined;
  const ruleId = searchParams.get("rule_id") || undefined;

  const fromEntity = searchParams.get("from_entity") || "";
  const fromType = searchParams.get("from_type") || "";
  const fromList = searchParams.get("from") === "list";

  const normalizedEntity = normalizeEntityName(entity);
  const displayEntity = getEntityDisplayName(entity);

  const [recordIssues, setRecordIssues] = useState<RecordIssue[]>([]);
  const [issuesLoading, setIssuesLoading] = useState(false);

  // Fetch issues for this record from Firestore (for the edit view)
  // Use raw entity from URL — matches Firestore stored values
  useEffect(() => {
    if (view !== "edit" || !entity || !recordId) return;

    const fetchIssues = async () => {
      setIssuesLoading(true);
      try {
        const issuesRef = collection(db, "integrity_issues");
        const q = query(
          issuesRef,
          where("entity", "==", entity),
          where("record_id", "==", recordId),
          where("status", "==", "open")
        );
        const snapshot = await getDocs(q);
        const issues: RecordIssue[] = snapshot.docs.map((doc) => {
          const data = doc.data();
          return {
            issue_type: data.issue_type || "",
            severity: data.severity || "info",
            rule_id: data.rule_id || "",
            description: data.description,
            related_records: data.related_records,
          };
        });
        setRecordIssues(issues);
      } catch (err) {
        console.error("[RemediationPage] Failed to fetch record issues:", err);
      } finally {
        setIssuesLoading(false);
      }
    };

    fetchIssues();
  }, [view, entity, recordId]);

  const backLabel = useMemo(() => {
    if (fromList) return "Back to Issues";
    if (fromEntity && fromType) {
      const label = ISSUE_TYPE_LABELS[fromType] || fromType;
      return `Back to ${getEntityDisplayName(fromEntity)} ${label}`;
    }
    return "Back to Issues";
  }, [fromList, fromEntity, fromType]);

  const handleBack = useCallback(() => {
    if (fromList) {
      navigate("/issues");
    } else if (fromEntity && fromType) {
      navigate(
        `/issues/queue?entity=${encodeURIComponent(fromEntity)}&type=${encodeURIComponent(fromType)}`
      );
    } else {
      navigate("/issues");
    }
  }, [navigate, fromList, fromEntity, fromType]);

  const handleMergeComplete = useCallback(async () => {
    const allRecordIds = [recordId, ...relatedRecords];
    // Firestore stores entity as written by scans (often singular, e.g. "student")
    await resolveIssues(allRecordIds, entity);
    handleBack();
  }, [recordId, relatedRecords, entity, resolveIssues, handleBack]);

  const handleEditComplete = useCallback(async () => {
    const ruleIds = recordIssues
      .map((i) => i.rule_id)
      .filter(Boolean);
    await resolveIssues(
      [recordId],
      entity,
      ruleIds.length > 0 ? ruleIds : undefined
    );
    handleBack();
  }, [recordId, entity, recordIssues, resolveIssues, handleBack]);

  if (view === "merge") {
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
            Compare and merge duplicate{" "}
            {displayEntity.toLowerCase()} records
          </p>
        </div>
        <DuplicateMergeView
          entity={normalizedEntity}
          integrityEntity={entity}
          primaryRecordId={recordId}
          secondaryRecordIds={relatedRecords}
          matchSeverity={severity}
          matchDescription={description}
          matchRuleId={ruleId}
          onBack={handleBack}
          onMergeComplete={handleMergeComplete}
        />
      </div>
    );
  }

  if (issuesLoading) {
    return (
      <div className="space-y-6">
        <button
          onClick={handleBack}
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
          {backLabel}
        </button>
        <div className="rounded-2xl border border-[var(--border)] bg-white p-8 text-center">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--brand)] mb-4" />
          <p className="text-[var(--text-muted)]">Loading issue data...</p>
        </div>
      </div>
    );
  }

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
          Fix issues on this {displayEntity.toLowerCase()} record
        </p>
      </div>
      <RecordEditor
        entity={normalizedEntity}
        recordId={recordId}
        issues={recordIssues}
        onBack={handleBack}
        onSaveComplete={handleEditComplete}
      />
    </div>
  );
}
