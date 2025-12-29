import { useMemo, useState, useRef, useEffect } from "react";
import { useIntegrityMetrics } from "../hooks/useIntegrityMetrics";
import type { RunHistoryItem } from "../hooks/useFirestoreRuns";
import { useNewIssuesFromRecentRuns } from "../hooks/useFirestoreRuns";
import { IssueList } from "./IssueList";
import {
  useFirestoreSchedules,
  type Schedule,
} from "../hooks/useFirestoreSchedules";
import { IssueTrendChart } from "./IssueTrendChart";
import { useIssueCounts } from "../hooks/useIssueCounts";

type DashboardContentProps = {
  integrityMetrics: ReturnType<typeof useIntegrityMetrics>;
  onRunScan: () => void;
  runScanLoading: boolean;
  selectedQueue: { type?: string; entity?: string } | null;
  onSelectQueue: (queue: { type?: string; entity?: string } | null) => void;
  onCloseQueue: () => void;
  selectedRun: RunHistoryItem | null;
  onSelectRun: (run: RunHistoryItem | null) => void;
  onCloseRun: () => void;
};

const DAYS_OF_WEEK = [
  { value: 0, label: "Sunday" },
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
];

function formatScheduleTime(timeOfDay: string): string {
  const [hours, minutes] = timeOfDay.split(":").map(Number);
  const date = new Date();
  date.setHours(hours, minutes, 0);
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function ScheduleTooltip({
  schedule,
  children,
}: {
  schedule: Schedule;
  children: React.ReactNode;
}) {
  const [isHovered, setIsHovered] = useState(false);
  const [mousePosition, setMousePosition] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [tooltipPosition, setTooltipPosition] = useState<{
    top?: number;
    bottom?: number;
    left?: number;
    right?: number;
    maxHeight?: string;
  }>({});
  const tooltipRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);

  // Track mouse position
  const handleMouseMove = (e: React.MouseEvent) => {
    setMousePosition({ x: e.clientX, y: e.clientY });
  };

  useEffect(() => {
    if (isHovered && mousePosition && tooltipRef.current) {
      // Use requestAnimationFrame to ensure tooltip is rendered before measuring
      requestAnimationFrame(() => {
        if (!tooltipRef.current || !mousePosition) return;

        const tooltipRect = tooltipRef.current.getBoundingClientRect();
        const viewportHeight = window.innerHeight;
        const viewportWidth = window.innerWidth;
        const padding = 8;
        const cursorOffset = 12; // Offset from cursor

        // Default: position below cursor
        let top: number | undefined = mousePosition.y + cursorOffset;
        let left: number | undefined = mousePosition.x;
        let bottom: number | undefined;
        let right: number | undefined;
        let maxHeight: string | undefined;

        // Check if tooltip would go below viewport
        if (
          top !== undefined &&
          top + tooltipRect.height > viewportHeight - padding
        ) {
          // Position above cursor instead
          top = undefined;
          bottom = viewportHeight - mousePosition.y + cursorOffset;

          // If it still doesn't fit above, constrain to viewport
          if (
            bottom !== undefined &&
            bottom + tooltipRect.height > viewportHeight - padding
          ) {
            bottom = padding;
            maxHeight = `${viewportHeight - padding * 2}px`;
          }
        }

        // Check if tooltip would go right of viewport
        if (
          left !== undefined &&
          left + tooltipRect.width > viewportWidth - padding
        ) {
          // Adjust to fit within viewport
          left = viewportWidth - tooltipRect.width - padding;
        }

        // Ensure it doesn't go left of viewport
        if (left !== undefined && left < padding) {
          left = padding;
        }

        setTooltipPosition({
          ...(top !== undefined && { top }),
          ...(bottom !== undefined && { bottom }),
          ...(left !== undefined && { left }),
          ...(right !== undefined && { right }),
          ...(maxHeight && { maxHeight }),
        });
      });
    } else {
      setTooltipPosition({});
      setMousePosition(null);
    }
  }, [isHovered, mousePosition]);

  // Format next run times
  const nextRuns = useMemo(() => {
    if (!schedule.next_run_at) return [];
    const runs: Date[] = [];
    let currentDate = schedule.next_run_at.toDate();

    // Generate next 10 runs based on frequency
    for (let i = 0; i < 10; i++) {
      runs.push(new Date(currentDate));

      if (schedule.frequency === "daily") {
        currentDate = new Date(currentDate.getTime() + 24 * 60 * 60 * 1000);
      } else if (
        schedule.frequency === "weekly" &&
        schedule.days_of_week &&
        schedule.days_of_week.length > 0
      ) {
        // Add 7 days for weekly
        currentDate = new Date(currentDate.getTime() + 7 * 24 * 60 * 60 * 1000);
      } else if (schedule.frequency === "hourly" && schedule.interval_minutes) {
        currentDate = new Date(
          currentDate.getTime() + schedule.interval_minutes * 60 * 1000
        );
      } else {
        // Default to daily if unknown
        currentDate = new Date(currentDate.getTime() + 24 * 60 * 60 * 1000);
      }
    }
    return runs;
  }, [schedule]);

  const displayTimezone =
    schedule.timezone === "America/Los_Angeles"
      ? "America/Denver"
      : schedule.timezone;

  return (
    <div
      ref={triggerRef}
      className="relative inline-block"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => {
        setIsHovered(false);
        setMousePosition(null);
      }}
      onMouseMove={handleMouseMove}
    >
      <span className="cursor-help underline decoration-dotted">
        {children}
      </span>
      {isHovered && nextRuns.length > 0 && (
        <div
          ref={tooltipRef}
          className="fixed z-[9999] w-64 bg-white border border-[var(--border)] rounded-lg shadow-xl p-3 overflow-y-auto"
          style={{
            top: tooltipPosition.top,
            bottom: tooltipPosition.bottom,
            left: tooltipPosition.left,
            right: tooltipPosition.right,
            maxHeight: tooltipPosition.maxHeight || "384px",
          }}
        >
          <div className="text-xs font-semibold text-[var(--text-main)] mb-2 pb-2 border-b border-[var(--border)]">
            Next 10 Runs
          </div>
          <div className="space-y-1.5">
            {nextRuns.map((runDate, index) => (
              <div
                key={index}
                className="text-xs text-[var(--text-muted)] py-1"
              >
                {runDate.toLocaleString("en-US", {
                  timeZone: displayTimezone,
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                  hour12: true,
                  timeZoneName: "short",
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function formatScheduleDescription(
  runConfig: { entities?: string[]; mode?: string },
  frequency: "daily" | "weekly" | "hourly" | "custom_times",
  scheduleName: string
): string {
  // Check if mode is specified in run_config
  if (runConfig.mode === "full") {
    return "All records";
  } else if (runConfig.mode === "incremental") {
    return "Changed records only";
  } else if (runConfig.mode === "sample") {
    return "Sample validation";
  }

  // Infer from schedule name if mode not specified
  const nameLower = scheduleName.toLowerCase();
  if (nameLower.includes("full") || nameLower.includes("weekly")) {
    return "All records";
  } else if (
    nameLower.includes("incremental") ||
    nameLower.includes("nightly")
  ) {
    return "Changed records only";
  } else if (nameLower.includes("sample") || nameLower.includes("kpi")) {
    return "Sample validation";
  }

  // Default based on frequency if name doesn't provide clues
  if (frequency === "daily") {
    return "Changed records only";
  } else if (frequency === "weekly") {
    return "All records";
  }
  return "Scheduled run";
}

export function DashboardContent({
  integrityMetrics,
  selectedQueue,
  onSelectQueue,
  onCloseQueue,
  onSelectRun,
}: DashboardContentProps) {
  const { summary, runs, trends, queues, derived, flaggedRules } =
    integrityMetrics;

  // Fetch enabled schedules
  const { data: schedules, loading: schedulesLoading } =
    useFirestoreSchedules();

  // Fetch new issues count from last 3 runs
  const { count: newIssuesCount, loading: newIssuesLoading } =
    useNewIssuesFromRecentRuns(3);

  // Fetch actual open issues count from Firestore
  const { counts: issueCounts, loading: issueCountsLoading } = useIssueCounts();

  // Filter and format enabled schedules for display
  const displaySchedules = useMemo(() => {
    if (!schedules) return [];

    return schedules
      .filter((schedule) => schedule.enabled)
      .slice(0, 3) // Show max 3 schedules
      .map((schedule) => {
        const timeStr = formatScheduleTime(schedule.time_of_day);
        const description = formatScheduleDescription(
          schedule.run_config,
          schedule.frequency,
          schedule.name
        );

        // Format day/time display
        let dayTimeDisplay = timeStr;
        if (
          schedule.frequency === "weekly" &&
          schedule.days_of_week &&
          schedule.days_of_week.length > 0
        ) {
          const dayName = DAYS_OF_WEEK[schedule.days_of_week[0]]?.label || "";
          dayTimeDisplay = `${dayName} ${timeStr}`;
        }

        return {
          id: schedule.id,
          name: schedule.name,
          dayTime: dayTimeDisplay,
          description,
        };
      });
  }, [schedules]);

  // Map queue titles to filter types
  const getQueueFilter = (
    title: string
  ): { type?: string; entity?: string } | null => {
    const mapping: Record<string, { type?: string; entity?: string }> = {
      "Duplicate Records": { type: "duplicate" },
      "Missing Links": { type: "missing_link" },
      "Attendance Anomalies": { type: "attendance" },
      "Missing Fields": { type: "missing_field" },
    };
    return mapping[title] || null;
  };

  // Calculate summary cards from real data
  const summaryCards = useMemo(() => {
    // Use actual open issues count from Firestore instead of summary total
    // Summary total counts all issues found in latest run (including duplicates that get merged)
    // Firestore count shows actual unique open issues
    const totalIssues = issueCountsLoading ? 0 : issueCounts.open;
    const bySeverity = summary.data?.summary?.by_severity || {};
    // Use actual critical issues count from Firestore (open issues with severity=critical)
    // instead of summary data which counts all critical issues found in latest run
    const criticalCount = issueCountsLoading ? 0 : issueCounts.critical;
    const lastRun = summary.data?.last_run;
    const baseHealth = derived.data?.base_health || 100;

    let lastRunTime = "Never";
    let lastRunBadge = "No runs yet";
    let lastRunContext = "Run integrity check to start";

    if (lastRun && summary.data?.last_run_time) {
      const runDate = new Date(summary.data.last_run_time);
      const timeStr = runDate.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
      });
      const dateStr = runDate.toLocaleDateString("en-US", {
        month: "numeric",
        day: "numeric",
      });
      lastRunTime = `${timeStr} ${dateStr}`;

      lastRunBadge = "Frequency: Nightly";
      const duration = summary.data.last_run_duration;
      if (duration) {
        const minutes = Math.floor(duration / 60000);
        const seconds = Math.floor((duration % 60000) / 1000);
        lastRunContext = `Length ${minutes}m ${seconds}s`;
      }
    }

    return [
      {
        label: "Last run",
        value: lastRunTime,
        badge: lastRunBadge,
        context: lastRunContext,
      },
      {
        label: "Critical records",
        value: criticalCount.toString(),
        badge: criticalCount > 0 ? "Needs outreach" : "None",
        context: "Attendance + billing gaps",
      },
      {
        label: "New Issues",
        value: newIssuesLoading ? "..." : newIssuesCount.toString(),
        badge: "Last 3 scans",
        context: "Issues discovered in recent runs",
      },
      {
        label: "Open Issues",
        value: totalIssues.toString(),
        badge:
          totalIssues > 0
            ? `${criticalCount} critical`
            : "All clear",
        context: "Duplicates, broken links, attendance",
      },
    ];
  }, [summary, derived, newIssuesCount, newIssuesLoading, issueCounts, issueCountsLoading]);

  // Use real issue queues or empty array
  const issueQueues = queues.data || [];

  // Use real run history or empty array
  const runHistory = runs.data || [];

  // Use real trend data or empty array
  const trendData = trends.data || [];

  // Use actual severity counts from Firestore (open issues only)
  // instead of summary data which counts all issues found in latest run
  const severityCounts = {
    critical: issueCountsLoading ? 0 : issueCounts.critical,
    warning: issueCountsLoading ? 0 : issueCounts.warning,
    info: issueCountsLoading ? 0 : issueCounts.info,
  };

  const totalSeverity =
    severityCounts.critical + severityCounts.warning + severityCounts.info;

  return (
    <>
      <section className="flex flex-col gap-6 lg:flex-row lg:items-stretch">
        <div className="flex-1 rounded-3xl border border-[var(--border)] bg-[var(--bg-light)] p-6 shadow-[0_30px_60px_rgba(31,79,72,0.08)]">
          <p className="text-sm uppercase tracking-[0.2em] text-[var(--text-muted)] mb-4">
            System Status
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            {summaryCards.map((card) => (
              <div
                key={card.label}
                className="rounded-2xl border border-[var(--border)] bg-[var(--bg-mid)]/70 p-4"
              >
                <p className="text-sm text-[var(--text-muted)]">{card.label}</p>
                <p
                  className="mt-2 text-3xl font-semibold"
                  style={{ fontFamily: "Outfit" }}
                >
                  {card.value}
                </p>
                <p className="text-sm text-[var(--brand)] font-medium">
                  {card.badge}
                </p>
                <p className="mt-1 text-sm text-[var(--text-muted)]">
                  {card.context}
                </p>
              </div>
            ))}
          </div>
        </div>

        <div className="w-full max-w-sm rounded-3xl border border-[var(--border)] bg-white p-6 shadow-[0_30px_60px_rgba(31,79,72,0.08)]">
          <p className="text-sm text-[var(--text-muted)]">Enabled Schedules</p>
          <div className="mt-4 space-y-4">
            {schedulesLoading ? (
              <div className="text-center text-sm text-[var(--text-muted)] py-4">
                Loading schedules...
              </div>
            ) : displaySchedules.length > 0 ? (
              displaySchedules.map((displaySchedule) => {
                const fullSchedule = schedules?.find(
                  (s) => s.id === displaySchedule.id
                );
                return (
                  <div key={displaySchedule.id}>
                    {fullSchedule ? (
                      <ScheduleTooltip schedule={fullSchedule}>
                        <p className="text-sm font-medium text-[var(--text-main)]">
                          {displaySchedule.name}
                        </p>
                      </ScheduleTooltip>
                    ) : (
                      <p className="text-sm font-medium text-[var(--text-main)]">
                        {displaySchedule.name}
                      </p>
                    )}
                    <p className="text-xs text-[var(--text-muted)] mt-1">
                      {displaySchedule.dayTime} · {displaySchedule.description}
                    </p>
                  </div>
                );
              })
            ) : (
              <div className="text-center text-sm text-[var(--text-muted)] py-4">
                No enabled schedules configured
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="rounded-3xl border border-[var(--border)] bg-white p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm uppercase tracking-[0.2em] text-[var(--text-muted)]">
                Trend
              </p>
              <p className="text-lg font-semibold text-[var(--text-main)]">
                Last 7 runs
              </p>
            </div>
            <span className="rounded-full border border-[var(--border)] px-3 py-1 text-sm text-[var(--text-muted)]">
              On target
            </span>
          </div>
          <div className="mt-5">
            <IssueTrendChart
              data={trendData}
              loading={trends.loading}
              error={trends.error}
            />
          </div>
        </div>

        <div className="rounded-3xl border border-[var(--border)] bg-white p-6">
          <p className="text-sm uppercase tracking-[0.2em] text-[var(--text-muted)]">
            Severity
          </p>
          <div className="mt-4 space-y-3">
            {[
              { label: "Critical", count: severityCounts.critical },
              { label: "Warning", count: severityCounts.warning },
              { label: "Info", count: severityCounts.info },
            ].map((severity, idx) => {
              const percentage =
                totalSeverity > 0
                  ? Math.round((severity.count / totalSeverity) * 100)
                  : 0;
              return (
                <div
                  key={idx}
                  className="flex items-center justify-between rounded-2xl border border-[var(--border)] bg-[var(--bg-mid)]/60 px-3 py-2 text-sm"
                >
                  <div>
                    <p className="text-xs text-[var(--text-muted)]">
                      {severity.label}
                    </p>
                    <p
                      className="text-lg font-semibold text-[var(--text-main)]"
                      style={{ fontFamily: "Outfit" }}
                    >
                      {severity.count}
                    </p>
                  </div>
                  <div className="text-right text-xs text-[var(--text-muted)]">
                    {totalSeverity > 0
                      ? `${percentage}% of issues`
                      : "No issues"}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section
        className="grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]"
        id="queues"
      >
        <div className="rounded-3xl border border-[var(--border)] bg-white p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm uppercase tracking-[0.2em] text-[var(--text-muted)]">
                Grouped issues
              </p>
            </div>
            {/* <a
              href={getDataIssuesLink()}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium text-[var(--cta-blue)] hover:underline"
            >
              Open in Airtable →
            </a> */}
          </div>
          {selectedQueue ? (
            <div className="mt-4">
              <div className="mb-4 flex items-center justify-between">
                <h3 className="text-lg font-semibold text-[var(--text-main)]">
                  Issue Details
                </h3>
                <button
                  onClick={onCloseQueue}
                  className="text-sm text-[var(--text-muted)] hover:text-[var(--text-main)]"
                >
                  ← Back to queues
                </button>
              </div>
              <IssueList filters={selectedQueue} onClose={onCloseQueue} />
            </div>
          ) : (
            <ul className="mt-4 space-y-3">
              {issueQueues.length > 0 ? (
                issueQueues.map((queue) => {
                  const filter = getQueueFilter(queue.title);
                  return (
                    <li
                      key={queue.title}
                      onClick={() => filter && onSelectQueue(filter)}
                      className="rounded-2xl border border-[var(--border)] bg-[var(--bg-mid)]/70 p-4 cursor-pointer hover:bg-[var(--bg-mid)] transition-colors"
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="font-semibold text-[var(--text-main)]">
                            {queue.title}
                          </p>
                          <p className="text-sm text-[var(--text-muted)]">
                            {queue.detail}
                          </p>
                        </div>
                        <div className="text-right">
                          <span className="rounded-full bg-white px-3 py-1 text-sm font-semibold text-[var(--text-main)]">
                            {queue.count}
                          </span>
                          <p className="text-xs text-[var(--text-muted)]">
                            {queue.chip}
                          </p>
                        </div>
                      </div>
                    </li>
                  );
                })
              ) : (
                <li className="text-center text-sm text-[var(--text-muted)] py-4">
                  {queues.loading
                    ? "Loading issue queues..."
                    : "No issue queues available yet"}
                </li>
              )}
            </ul>
          )}
        </div>

        {flaggedRules.data && flaggedRules.data.length > 0 && (
          <div className="rounded-3xl border border-[var(--border)] bg-white p-6">
            <div className="mb-4">
              <p className="text-sm uppercase tracking-[0.2em] text-[var(--text-muted)]">
                Rule Tuning
              </p>
              <p className="text-lg font-semibold text-[var(--text-main)]">
                Most Ignored Rules
              </p>
              <p className="text-sm text-[var(--text-muted)] mt-1">
                Rules with &gt;10% ignored issues need review
              </p>
            </div>
            <ul className="space-y-2">
              {flaggedRules.data.slice(0, 5).map((rule) => (
                <li
                  key={rule.rule_id}
                  className="rounded-2xl border border-[var(--border)] bg-[var(--bg-mid)]/70 p-3"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex-1">
                      <p className="font-mono text-xs text-[var(--text-main)]">
                        {rule.rule_id}
                      </p>
                      <p className="text-xs text-[var(--text-muted)] mt-1">
                        {rule.ignored_count} of {rule.total_count} ignored
                      </p>
                    </div>
                    <div className="text-right">
                      <span className="rounded-full bg-[#ffecc7] text-[#b35300] px-3 py-1 text-sm font-semibold">
                        {rule.ignored_percentage.toFixed(1)}%
                      </span>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            {flaggedRules.loading && (
              <div className="text-center text-sm text-[var(--text-muted)] py-4">
                Loading flagged rules...
              </div>
            )}
          </div>
        )}

        <div className="rounded-3xl border border-[var(--border)] bg-white p-6 space-y-4">
          <div>
            <p className="text-sm uppercase tracking-[0.2em] text-[var(--text-muted)]">
              Run log
            </p>
            <p className="text-lg font-semibold">Recent runs</p>
          </div>
          <div className="space-y-3">
            {runHistory.length > 0 ? (
              runHistory.map((run) => (
                <div
                  key={run.id}
                  onClick={() => onSelectRun(run)}
                  className="rounded-2xl border border-[var(--border)] bg-[var(--bg-mid)]/60 px-3 py-2 text-sm cursor-pointer hover:bg-[var(--bg-mid)] transition-colors"
                >
                  <p className="font-semibold text-[var(--text-main)]">
                    {run.time}
                  </p>
                  <p className="text-[var(--text-muted)]">
                    {run.trigger} • {run.anomalies} anomalies • {run.status} •{" "}
                    {run.duration}
                  </p>
                </div>
              ))
            ) : (
              <div className="text-center text-sm text-[var(--text-muted)] py-4">
                {runs.loading
                  ? "Loading run history..."
                  : "No run history available yet"}
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-lg font-semibold">All open issues</p>
          </div>
        </div>
        <div className="overflow-hidden rounded-3xl border border-[var(--border)] bg-white p-6">
          <IssueList />
        </div>
      </section>
    </>
  );
}
