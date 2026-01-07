import { useEffect, useState } from "react";
import {
  collection,
  query,
  where,
  getCountFromServer,
} from "firebase/firestore";
import { db } from "../config/firebase";

interface IssueCounts {
  all: number;
  open: number;
  openExcludingInfo: number;
  closed: number;
  resolved: number;
  critical: number;
  warning: number;
  info: number;
}

export function useIssueCounts() {
  const [counts, setCounts] = useState<IssueCounts>({
    all: 0,
    open: 0,
    openExcludingInfo: 0,
    closed: 0,
    resolved: 0,
    critical: 0,
    warning: 0,
    info: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchCounts() {
      try {
        const issuesRef = collection(db, "integrity_issues");

        // Run all count queries in parallel
        const [
          allResult,
          openResult,
          openExcludingInfoResult,
          closedResult,
          resolvedResult,
          criticalResult,
          warningResult,
          infoResult,
        ] = await Promise.all([
          getCountFromServer(query(issuesRef)),
          getCountFromServer(
            query(issuesRef, where("status", "==", "open"))
          ),
          getCountFromServer(
            query(
              issuesRef,
              where("status", "==", "open"),
              where("severity", "in", ["critical", "warning"])
            )
          ),
          getCountFromServer(
            query(issuesRef, where("status", "==", "closed"))
          ),
          getCountFromServer(
            query(issuesRef, where("status", "==", "resolved"))
          ),
          getCountFromServer(
            query(
              issuesRef,
              where("status", "==", "open"),
              where("severity", "==", "critical")
            )
          ),
          getCountFromServer(
            query(
              issuesRef,
              where("status", "==", "open"),
              where("severity", "==", "warning")
            )
          ),
          getCountFromServer(
            query(
              issuesRef,
              where("status", "==", "open"),
              where("severity", "==", "info")
            )
          ),
        ]);

        if (!cancelled) {
          setCounts({
            all: allResult.data().count,
            open: openResult.data().count,
            openExcludingInfo: openExcludingInfoResult.data().count,
            closed:
              closedResult.data().count + resolvedResult.data().count,
            resolved: resolvedResult.data().count,
            critical: criticalResult.data().count,
            warning: warningResult.data().count,
            info: infoResult.data().count,
          });
          setError(null);
        }
      } catch (err) {
        console.error("Error fetching issue counts:", err);
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Failed to fetch counts"
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    fetchCounts();

    // Refresh counts every 30 seconds
    const interval = setInterval(fetchCounts, 30000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return { counts, loading, error };
}

export interface IssueCountsByType {
  duplicate: number;
  missing_link: number;
  attendance: number;
  missing_field: number;
}

export function useIssueCountsByType() {
  const [counts, setCounts] = useState<IssueCountsByType>({
    duplicate: 0,
    missing_link: 0,
    attendance: 0,
    missing_field: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchCounts() {
      try {
        const issuesRef = collection(db, "integrity_issues");

        // Run all count queries in parallel for each issue type (excluding info severity)
        const [
          duplicateResult,
          missingLinkResult,
          attendanceResult,
          missingFieldResult,
        ] = await Promise.all([
          getCountFromServer(
            query(
              issuesRef,
              where("status", "==", "open"),
              where("issue_type", "==", "duplicate"),
              where("severity", "in", ["critical", "warning"])
            )
          ),
          getCountFromServer(
            query(
              issuesRef,
              where("status", "==", "open"),
              where("issue_type", "==", "missing_link"),
              where("severity", "in", ["critical", "warning"])
            )
          ),
          getCountFromServer(
            query(
              issuesRef,
              where("status", "==", "open"),
              where("issue_type", "==", "attendance"),
              where("severity", "in", ["critical", "warning"])
            )
          ),
          getCountFromServer(
            query(
              issuesRef,
              where("status", "==", "open"),
              where("issue_type", "==", "missing_field"),
              where("severity", "in", ["critical", "warning"])
            )
          ),
        ]);

        if (!cancelled) {
          setCounts({
            duplicate: duplicateResult.data().count,
            missing_link: missingLinkResult.data().count,
            attendance: attendanceResult.data().count,
            missing_field: missingFieldResult.data().count,
          });
          setError(null);
        }
      } catch (err) {
        console.error("Error fetching issue counts by type:", err);
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Failed to fetch counts by type"
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    fetchCounts();

    // Refresh counts every 30 seconds
    const interval = setInterval(fetchCounts, 30000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return { counts, loading, error };
}
