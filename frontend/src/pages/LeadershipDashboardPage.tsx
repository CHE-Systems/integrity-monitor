import {
  useLeadershipMetrics,
  type HealthStatus,
  type LeadershipCategory,
} from "../hooks/useLeadershipMetrics";
import { LeadershipTrendChart } from "../components/LeadershipTrendChart";

function HealthIndicator({ status }: { status: HealthStatus }) {
  const config = {
    excellent: {
      bg: "bg-emerald-50",
      border: "border-emerald-200",
      dot: "bg-emerald-500",
      text: "text-emerald-700",
    },
    good: {
      bg: "bg-sky-50",
      border: "border-sky-200",
      dot: "bg-sky-500",
      text: "text-sky-700",
    },
    attention: {
      bg: "bg-amber-50",
      border: "border-amber-200",
      dot: "bg-amber-500",
      text: "text-amber-700",
    },
    critical: {
      bg: "bg-rose-50",
      border: "border-rose-200",
      dot: "bg-rose-500",
      text: "text-rose-700",
    },
  };

  const c = config[status];

  return (
    <div
      className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full ${c.bg} ${c.border} border`}
    >
      <span className={`w-2 h-2 rounded-full ${c.dot} animate-pulse`} />
      <span className={`text-sm font-medium ${c.text}`}>
        {status === "excellent" && "All Clear"}
        {status === "good" && "Minor Items"}
        {status === "attention" && "Review Needed"}
        {status === "critical" && "Action Required"}
      </span>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="min-h-screen bg-[var(--bg-warm-light)] animate-pulse">
      <div className="max-w-4xl mx-auto px-6 py-12">
        <div className="h-8 w-48 bg-gray-200 rounded mb-8" />
        <div className="bg-white rounded-3xl p-8 mb-6">
          <div className="h-12 w-64 bg-gray-200 rounded mb-4" />
          <div className="h-6 w-96 bg-gray-100 rounded" />
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="bg-white rounded-2xl p-6 h-32" />
          <div className="bg-white rounded-2xl p-6 h-32" />
        </div>
      </div>
    </div>
  );
}

import { useState } from "react";
import { CategoryIssueList } from "../components/CategoryIssueList";

function CategoryCard({ category }: { category: LeadershipCategory }) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className="group flex flex-col rounded-2xl transition-all duration-300 bg-[var(--bg-mid)]/60 hover:bg-[var(--bg-mid)] p-4 shadow-sm">
      <div
        className="flex items-center justify-between cursor-pointer select-none"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex-1 min-w-0 pr-4">
          <p className="font-semibold text-[var(--text-main)] group-hover:text-[var(--brand)] transition-colors">
            {category.label}
          </p>
          <p className="text-sm text-[var(--text-muted)] line-clamp-1">
            {category.description}
          </p>
        </div>
        <div className="flex items-center gap-6">
          <div className="text-right">
            <span
              className="text-2xl font-bold text-[var(--text-main)] block leading-none"
              style={{ fontFamily: "Outfit" }}
            >
              {category.count}
            </span>
            <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] font-medium">
              Items
            </span>
          </div>
          <div
            className={`flex h-8 w-8 items-center justify-center rounded-full transition-all duration-300 ${
              !isExpanded ? "-rotate-90" : ""
            }`}
          >
            <svg
              className="w-5 h-5 text-[var(--text-muted)] group-hover:text-[var(--brand)] transition-colors duration-300"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 9l-7 7-7-7"
              />
            </svg>
          </div>
        </div>
      </div>

      {isExpanded && (
        <div className="mt-2 pt-2 border-t border-[var(--border)]/40 animate-in fade-in slide-in-from-top-1 duration-200">
          <CategoryIssueList
            filter={category.filter}
            totalCount={category.count}
          />
        </div>
      )}
    </div>
  );
}

export function LeadershipDashboardPage() {
  const metrics = useLeadershipMetrics();

  if (metrics.loading) {
    return <LoadingSkeleton />;
  }

  return (
    <div className="min-h-[calc(100vh-80px)] bg-[var(--bg-warm-light)]">
      <div className="max-w-4xl mx-auto px-6 py-10">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-2xl font-semibold text-[var(--text-main)]">
            Data Integrity Overview
          </h1>
          <p className="text-[var(--text-muted)] mt-1">
            Last checked {metrics.lastCheckRelative}
          </p>
        </div>

        {/* Main Health Status Card */}
        <div className="bg-white rounded-3xl border border-[var(--border)] p-8 mb-6 shadow-sm">
          <div className="flex items-start justify-between mb-6">
            <div>
              <p className="text-sm uppercase tracking-widest text-[var(--text-muted)] mb-2">
                System Status
              </p>
              <h2
                className="text-5xl font-semibold text-[var(--text-main)] mb-2"
                style={{ fontFamily: "Outfit" }}
              >
                {metrics.healthLabel}
              </h2>
              <p className="text-lg text-[var(--text-muted)] max-w-lg">
                {metrics.healthDescription}
              </p>
            </div>
            <HealthIndicator status={metrics.healthStatus} />
          </div>

          {/* Key Numbers */}
          <div className="grid grid-cols-2 gap-4 pt-6 border-t border-[var(--border)]">
            <div className="text-center py-4">
              <p
                className="text-4xl font-semibold text-[var(--text-main)]"
                style={{ fontFamily: "Outfit" }}
              >
                {metrics.totalOpenIssues}
              </p>
              <p className="text-sm text-[var(--text-muted)] mt-1">
                {metrics.totalOpenIssues === 1 ? "Item" : "Items"} to Review
              </p>
            </div>
            <div className="text-center py-4 border-l border-[var(--border)]">
              <p
                className={`text-4xl font-semibold ${
                  metrics.criticalIssues > 0
                    ? "text-rose-600"
                    : "text-[var(--text-main)]"
                }`}
                style={{ fontFamily: "Outfit" }}
              >
                {metrics.criticalIssues}
              </p>
              <p className="text-sm text-[var(--text-muted)] mt-1">Urgent</p>
            </div>
          </div>
        </div>

        {/* Monthly Trend Chart */}
        <div className="bg-white rounded-3xl border border-[var(--border)] p-6 mb-6 shadow-sm">
          <p className="text-sm uppercase tracking-widest text-[var(--text-muted)] mb-4">
            Last 30 Days
          </p>
          <LeadershipTrendChart
            data={metrics.monthlyTrend}
            loading={metrics.monthlyTrendLoading}
          />
        </div>

        {/* Categories */}
        {metrics.categories.length > 0 && (
          <div className="bg-white rounded-3xl border border-[var(--border)] p-6 shadow-sm">
            <p className="text-sm uppercase tracking-widest text-[var(--text-muted)] mb-4">
              By Category
            </p>
            <div className="space-y-3">
              {metrics.categories.map((category) => (
                <CategoryCard key={category.label} category={category} />
              ))}
            </div>
          </div>
        )}

        {/* Empty State */}
        {metrics.categories.length === 0 && metrics.totalOpenIssues === 0 && (
          <div className="bg-white rounded-3xl border border-[var(--border)] p-12 text-center shadow-sm">
            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-emerald-100 flex items-center justify-center">
              <svg
                className="w-8 h-8 text-emerald-600"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M5 13l4 4L19 7"
                />
              </svg>
            </div>
            <h3 className="text-xl font-semibold text-[var(--text-main)] mb-2">
              Everything looks great
            </h3>
            <p className="text-[var(--text-muted)] max-w-sm mx-auto">
              No data integrity issues found. The system is running smoothly.
            </p>
          </div>
        )}

        {/* Footer Note */}
        <p className="text-center text-sm text-[var(--text-muted)] mt-8">
          Automated checks run daily. For details, contact your system
          administrator.
        </p>
      </div>
    </div>
  );
}
