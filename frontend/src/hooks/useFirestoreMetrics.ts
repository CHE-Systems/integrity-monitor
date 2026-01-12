import { useEffect, useState } from "react";
import {
  collection,
  query,
  orderBy,
  limit,
  onSnapshot,
  where,
  Timestamp,
} from "firebase/firestore";
import { db } from "../config/firebase";

export interface TrendDataItem {
  day: string;
  total?: number;
  [key: string]: any;
}

export interface SeverityCounts {
  critical: number;
  warning: number;
  info: number;
}

export function useFirestoreMetrics(days: number = 14) {
  const [trends, setTrends] = useState<TrendDataItem[]>([]);
  const [severityCounts, setSeverityCounts] = useState<SeverityCounts>({ critical: 0, warning: 0, info: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Query runs from the last N days
    const runsRef = collection(db, "integrity_runs");
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);
    const cutoffTimestamp = Timestamp.fromDate(cutoffDate);

    const q = query(
      runsRef,
      where("started_at", ">=", cutoffTimestamp),
      orderBy("started_at", "desc")
    );

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        try {
          // Group runs by day and aggregate counts
          const dayMap = new Map<string, {
            day: string;
            date: Date;
            typeCounts: Record<string, number>;
            severityCounts: { critical: number; warning: number; info: number };
          }>();

          snapshot.docs.forEach((doc) => {
            const data = doc.data();
            const startedAt = data.started_at?.toDate?.() || new Date();
            const runDate = startedAt instanceof Date ? startedAt : new Date(startedAt);

            // Get date key (YYYY-MM-DD format for grouping)
            const dateKey = runDate.toISOString().split('T')[0];
            const dayLabel = runDate.toLocaleDateString("en-US", { month: "short", day: "numeric" });

            // Get counts from run
            const counts = data.counts || {};
            const byType = counts.by_type || {};
            const bySeverity = counts.by_severity || {};

            // Initialize day entry if not exists
            if (!dayMap.has(dateKey)) {
              dayMap.set(dateKey, {
                day: dayLabel,
                date: new Date(runDate.getFullYear(), runDate.getMonth(), runDate.getDate()),
                typeCounts: {},
                severityCounts: { critical: 0, warning: 0, info: 0 },
              });
            }

            const dayEntry = dayMap.get(dateKey)!;

            // Since runs are sorted descending (newest first), the first run we see for each day
            // is the most recent run for that day. Use that run's counts.
            // For today specifically, always use the most recent run (first one we encounter)
            const isToday = dateKey === new Date().toISOString().split('T')[0];
            const isFirstRunForDay = Object.keys(dayEntry.typeCounts).length === 0;

            if (isFirstRunForDay) {
              // Use this run's counts (most recent for this day)
              Object.entries(byType).forEach(([type, count]) => {
                if (typeof count === 'number') {
                  dayEntry.typeCounts[type] = count;
                }
              });

              // Update severity counts
              dayEntry.severityCounts = {
                critical: bySeverity.critical || 0,
                warning: bySeverity.warning || 0,
                info: bySeverity.info || 0,
              };

              // Store the pre-calculated total from the run
              // We cast it as number because it might be undefined in older runs
              (dayEntry as any).total = typeof counts.total === 'number' ? counts.total : 0;
            } else if (isToday) {
              // For today, if we see a newer run, update to use it (runs are sorted desc, so this shouldn't happen)
              // But just in case, we'll keep the first one (most recent) we saw
            }
          });

          // Convert to trend data array and sort by date
          const trendData: TrendDataItem[] = Array.from(dayMap.values())
            .sort((a, b) => a.date.getTime() - b.date.getTime())
            .map((entry) => {
              const trendItem: TrendDataItem = {
                day: entry.day,
                total: (entry as any).total || 0,
              };

              // Add all issue types
              Object.entries(entry.typeCounts).forEach(([type, count]) => {
                if (count > 0) {
                  trendItem[type] = count;
                }
              });

              return trendItem;
            });

          // Get latest severity counts (from today's run if available, otherwise most recent)
          let latestSeverity = { critical: 0, warning: 0, info: 0 };
          const todayKey = new Date().toISOString().split('T')[0];
          const todayEntry = dayMap.get(todayKey);
          if (todayEntry) {
            latestSeverity = todayEntry.severityCounts;
          } else if (dayMap.size > 0) {
            // Use most recent day's severity counts
            const sortedEntries = Array.from(dayMap.values())
              .sort((a, b) => b.date.getTime() - a.date.getTime());
            if (sortedEntries.length > 0) {
              latestSeverity = sortedEntries[0].severityCounts;
            }
          }

          setTrends(trendData);
          setSeverityCounts(latestSeverity);
          setLoading(false);
          setError(null);
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to process run data");
          setLoading(false);
        }
      },
      (err) => {
        setError(err.message);
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [days]);

  return { trends, severityCounts, loading, error };
}

