import { useEffect, useState } from "react";
import {
  collection,
  query,
  where,
  Timestamp,
  getDocs,
  orderBy,
} from "firebase/firestore";
import { db } from "../config/firebase";
import type { TrendDataItem } from "./useFirestoreMetrics";

export function useNewIssuesByDay(days: number = 30) {
  const [trends, setTrends] = useState<TrendDataItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchNewIssuesByDay() {
      try {
        setLoading(true);
        setError(null);

        // Query runs from the last N days
        const runsRef = collection(db, "integrity_runs");
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - days);
        const cutoffTimestamp = Timestamp.fromDate(cutoffDate);

        const runsQuery = query(
          runsRef,
          where("started_at", ">=", cutoffTimestamp),
          orderBy("started_at", "desc")
        );

        const runsSnapshot = await getDocs(runsQuery);

        // Group runs by day and collect run IDs
        const dayMap = new Map<
          string,
          {
            day: string;
            date: Date;
            runIds: string[];
          }
        >();

        runsSnapshot.docs.forEach((doc) => {
          const data = doc.data();
          const startedAt = data.started_at?.toDate?.() || new Date();
          const runDate = startedAt instanceof Date ? startedAt : new Date(startedAt);

          // Get date key (YYYY-MM-DD format for grouping)
          const dateKey = runDate.toISOString().split("T")[0];
          const dayLabel = runDate.toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
          });

          if (!dayMap.has(dateKey)) {
            dayMap.set(dateKey, {
              day: dayLabel,
              date: new Date(
                runDate.getFullYear(),
                runDate.getMonth(),
                runDate.getDate()
              ),
              runIds: [],
            });
          }

          dayMap.get(dateKey)!.runIds.push(doc.id);
        });

        // Query issues for each day
        const issuesRef = collection(db, "integrity_issues");
        const dayCounts = new Map<string, number>();

        // Initialize all days with 0 (including days with no runs)
        const today = new Date();
        for (let i = 0; i < days; i++) {
          const date = new Date(today);
          date.setDate(date.getDate() - i);
          const dateKey = date.toISOString().split("T")[0];
          const dayLabel = date.toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
          });

          if (!dayMap.has(dateKey)) {
            dayMap.set(dateKey, {
              day: dayLabel,
              date: new Date(date.getFullYear(), date.getMonth(), date.getDate()),
              runIds: [],
            });
          }
          dayCounts.set(dateKey, 0);
        }

        // Query issues for each day's runs
        // Firestore 'in' operator supports up to 10 values, so we need to batch
        for (const [dateKey, dayData] of dayMap.entries()) {
          if (dayData.runIds.length === 0) {
            continue; // No runs for this day, count stays 0
          }

          // Query in batches of 10 (Firestore limit)
          // Exclude info severity issues - only count critical and warning
          let dayCount = 0;
          for (let i = 0; i < dayData.runIds.length; i += 10) {
            const batch = dayData.runIds.slice(i, i + 10);
            const issuesQuery = query(
              issuesRef,
              where("first_seen_in_run", "in", batch),
              where("severity", "in", ["critical", "warning"])
            );
            const issuesSnapshot = await getDocs(issuesQuery);
            dayCount += issuesSnapshot.docs.length;
          }

          dayCounts.set(dateKey, dayCount);
        }

        if (cancelled) return;

        // Convert to trend data array and sort by date
        const sortedEntries = Array.from(dayMap.entries()).sort(
          (a, b) => a[1].date.getTime() - b[1].date.getTime()
        );

        const finalTrendData: TrendDataItem[] = sortedEntries.map(([dateKey, dayData]) => ({
          day: dayData.day,
          total: dayCounts.get(dateKey) || 0,
        }));

        if (!cancelled) {
          setTrends(finalTrendData);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to fetch new issues");
          setLoading(false);
        }
      }
    }

    fetchNewIssuesByDay();

    return () => {
      cancelled = true;
    };
  }, [days]);

  return { trends, loading, error };
}

