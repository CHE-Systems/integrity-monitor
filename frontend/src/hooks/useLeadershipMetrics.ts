import { useMemo } from "react";
import { useIssueCounts } from "./useIssueCounts";
import { useFirestoreRuns } from "./useFirestoreRuns";
import { useFirestoreMetrics } from "./useFirestoreMetrics";

export type HealthStatus = "excellent" | "good" | "attention" | "critical";

export type TrendDirection = "improving" | "stable" | "declining";

export type LeadershipCategory = {
  label: string;
  count: number;
  description: string;
};

export type MonthlyTrendItem = {
  day: string;
  total: number;
  date: Date;
};

export type LeadershipMetrics = {
  // Overall health
  healthStatus: HealthStatus;
  healthLabel: string;
  healthDescription: string;

  // Total counts
  totalOpenIssues: number;
  criticalIssues: number;

  // Trend
  trend: TrendDirection;
  trendLabel: string;
  trendPercentage: number | null;

  // Monthly trend data for chart
  monthlyTrend: MonthlyTrendItem[];
  monthlyTrendLoading: boolean;

  // Categories (human-friendly)
  categories: LeadershipCategory[];

  // Last check info
  lastCheckDate: string | null;
  lastCheckRelative: string;

  // Loading states
  loading: boolean;
};

function getHealthStatus(critical: number, total: number): HealthStatus {
  if (total === 0) return "excellent";
  if (critical > 0) return "critical";
  if (total > 20) return "attention";
  if (total > 5) return "good";
  return "excellent";
}

function getHealthLabel(status: HealthStatus): string {
  switch (status) {
    case "excellent":
      return "Excellent";
    case "good":
      return "Good";
    case "attention":
      return "Needs Attention";
    case "critical":
      return "Requires Action";
  }
}

function getHealthDescription(status: HealthStatus, total: number, critical: number): string {
  switch (status) {
    case "excellent":
      return "All systems are running smoothly with no outstanding issues.";
    case "good":
      return `${total} minor item${total === 1 ? '' : 's'} to review when convenient.`;
    case "attention":
      return `${total} items need attention. Review recommended this week.`;
    case "critical":
      return `${critical} urgent item${critical === 1 ? '' : 's'} require${critical === 1 ? 's' : ''} immediate attention.`;
  }
}

function getRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins} minute${diffMins === 1 ? '' : 's'} ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function calculateTrend(
  runs: Array<{ counts?: { total?: number } }>
): { direction: TrendDirection; percentage: number | null } {
  if (runs.length < 2) {
    return { direction: "stable", percentage: null };
  }

  // Get issue counts from last few runs
  const recentCounts = runs
    .slice(0, 5)
    .map(r => r.counts?.total ?? 0)
    .filter(c => c !== undefined);

  if (recentCounts.length < 2) {
    return { direction: "stable", percentage: null };
  }

  const latest = recentCounts[0];
  const previous = recentCounts[recentCounts.length - 1];

  if (previous === 0 && latest === 0) {
    return { direction: "stable", percentage: 0 };
  }

  if (previous === 0) {
    return { direction: "declining", percentage: 100 };
  }

  const percentChange = ((latest - previous) / previous) * 100;

  if (Math.abs(percentChange) < 5) {
    return { direction: "stable", percentage: Math.round(percentChange) };
  }

  return {
    direction: percentChange < 0 ? "improving" : "declining",
    percentage: Math.abs(Math.round(percentChange)),
  };
}

function getTrendLabel(direction: TrendDirection, percentage: number | null): string {
  if (percentage === null) {
    return "Not enough data yet";
  }

  switch (direction) {
    case "improving":
      return `Improving${percentage > 0 ? ` (${percentage}% fewer issues)` : ''}`;
    case "stable":
      return "Holding steady";
    case "declining":
      return `Needs attention${percentage > 0 ? ` (${percentage}% more issues)` : ''}`;
  }
}

export function useLeadershipMetrics(): LeadershipMetrics {
  const { counts, loading: countsLoading } = useIssueCounts();
  const { data: runs, loading: runsLoading } = useFirestoreRuns(10);
  const { trends, loading: trendsLoading } = useFirestoreMetrics(7);
  // Get 30 days of data for the monthly trend chart
  const { trends: monthlyTrends, loading: monthlyTrendsLoading } = useFirestoreMetrics(30);

  return useMemo(() => {
    const loading = countsLoading || runsLoading;

    const totalOpenIssues = counts.open;
    const criticalIssues = counts.critical;

    // Health status
    const healthStatus = getHealthStatus(criticalIssues, totalOpenIssues);
    const healthLabel = getHealthLabel(healthStatus);
    const healthDescription = getHealthDescription(healthStatus, totalOpenIssues, criticalIssues);

    // Trend calculation
    const { direction: trend, percentage: trendPercentage } = calculateTrend(runs);
    const trendLabel = getTrendLabel(trend, trendPercentage);

    // Last check info
    const lastRun = runs[0];
    let lastCheckDate: string | null = null;
    let lastCheckRelative = "No checks yet";

    if (lastRun?.started_at) {
      const date = lastRun.started_at.toDate();
      lastCheckDate = date.toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
      lastCheckRelative = getRelativeTime(date);
    }

    // Build human-friendly categories
    // Group by issue type from the trends data
    const categories: LeadershipCategory[] = [];

    if (counts.critical > 0) {
      categories.push({
        label: "Urgent Items",
        count: counts.critical,
        description: "Records requiring immediate attention",
      });
    }

    // We'll derive these from the latest run or trends if available
    const latestTrend = trends[0];
    if (latestTrend) {
      if (latestTrend.duplicates > 0) {
        categories.push({
          label: "Possible Duplicates",
          count: latestTrend.duplicates,
          description: "People who may have multiple records",
        });
      }
      if (latestTrend.links > 0) {
        categories.push({
          label: "Incomplete Records",
          count: latestTrend.links,
          description: "Records missing required connections",
        });
      }
      if (latestTrend.attendance > 0) {
        categories.push({
          label: "Attendance Concerns",
          count: latestTrend.attendance,
          description: "Students with attendance patterns to review",
        });
      }
      if (latestTrend.missing_field > 0) {
        categories.push({
          label: "Missing Information",
          count: latestTrend.missing_field,
          description: "Records with required fields not filled in",
        });
      }
    }

    // If no categories from trends, show a summary
    if (categories.length === 0 && totalOpenIssues > 0) {
      categories.push({
        label: "Items to Review",
        count: totalOpenIssues,
        description: "Records that may need attention",
      });
    }

    // Transform monthly trends into aggregated totals for the chart
    const monthlyTrend: MonthlyTrendItem[] = monthlyTrends.map((item) => {
      // Sum all issue types for this day
      let total = 0;
      Object.entries(item).forEach(([key, value]) => {
        if (key !== "day" && typeof value === "number") {
          total += value;
        }
      });

      // Parse the day string to create a Date object
      // The day format is "Mon D" like "Dec 15"
      const currentYear = new Date().getFullYear();
      const dateStr = `${item.day} ${currentYear}`;
      const parsedDate = new Date(dateStr);

      return {
        day: item.day,
        total,
        date: parsedDate,
      };
    });

    return {
      healthStatus,
      healthLabel,
      healthDescription,
      totalOpenIssues,
      criticalIssues,
      trend,
      trendLabel,
      trendPercentage,
      monthlyTrend,
      monthlyTrendLoading: monthlyTrendsLoading,
      categories,
      lastCheckDate,
      lastCheckRelative,
      loading,
    };
  }, [counts, runs, trends, monthlyTrends, countsLoading, runsLoading, trendsLoading, monthlyTrendsLoading]);
}
