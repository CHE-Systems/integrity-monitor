import { useParams, useNavigate } from "react-router-dom";
import { useState, useRef, useEffect } from "react";
import { useRunStatus } from "../hooks/useRunStatus";
import { useRunLogs } from "../hooks/useRunLogs";
import { useAuth } from "../hooks/useAuth";
import { API_BASE } from "../config/api";
import { IssueList } from "../components/IssueList";
import {
  collection,
  query,
  where,
  getDocs,
  limit,
  onSnapshot,
} from "firebase/firestore";
import { db } from "../config/firebase";
import { doc, getDoc } from "firebase/firestore";
import { formatRuleId } from "../utils/ruleFormatter";

export function RunStatusPage() {
  const { runId } = useParams<{ runId: string }>();
  const navigate = useNavigate();
  const { runStatus, loading, error } = useRunStatus(runId || null);
  const { logs, loading: logsLoading } = useRunLogs(runId || null);
  const { getToken } = useAuth();
  const [isCancelling, setIsCancelling] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [activeIssueTab, setActiveIssueTab] = useState<"new" | "all">("new");
  const logsContainerRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const [scheduleInfo, setScheduleInfo] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [rulesUsed, setRulesUsed] = useState<
    Array<{
      rule_id: string;
      category: string;
      entity?: string;
      ruleId: string;
      displayName: string;
    }>
  >([]);
  const [loadingRules, setLoadingRules] = useState(false);
  const [showApiSnippet, setShowApiSnippet] = useState(false);
  const [snippetTab, setSnippetTab] = useState<"curl" | "python" | "js">("curl");
  const [snippetCopied, setSnippetCopied] = useState(false);
  const [isRerunning, setIsRerunning] = useState(false);

  // Calculate isRunning safely - will be false if runStatus is not available yet
  const statusLower = runStatus?.status?.toLowerCase() || "";
  const isRunning = runStatus
    ? (runStatus.status === "running" || !runStatus.ended_at) &&
      statusLower !== "cancelled" &&
      statusLower !== "canceled" &&
      statusLower !== "success" &&
      statusLower !== "error" &&
      statusLower !== "warning" &&
      statusLower !== "healthy" &&
      statusLower !== "critical"
    : false;

  // Reset isCancelling when status actually changes to cancelled
  useEffect(() => {
    if (
      isCancelling &&
      (statusLower === "cancelled" || statusLower === "canceled")
    ) {
      setIsCancelling(false);
    }
  }, [statusLower, isCancelling]);

  // Handle auto-scroll for logs - only scroll if user is at bottom
  useEffect(() => {
    if (!logsContainerRef.current || !shouldAutoScrollRef.current) return;

    const container = logsContainerRef.current;
    const isAtBottom =
      container.scrollHeight - container.scrollTop <=
      container.clientHeight + 10;

    if (isAtBottom && logs.length > 0) {
      container.scrollTop = container.scrollHeight;
    }
  }, [logs]);

  // Track scroll position to determine if we should auto-scroll
  const handleLogsScroll = () => {
    if (!logsContainerRef.current) return;
    const container = logsContainerRef.current;
    const isAtBottom =
      container.scrollHeight - container.scrollTop <=
      container.clientHeight + 10;
    shouldAutoScrollRef.current = isAtBottom;
  };

  // Fetch schedule info if trigger is "schedule"
  useEffect(() => {
    if (!runId || runStatus?.trigger !== "schedule") {
      setScheduleInfo(null);
      return;
    }

    const fetchScheduleInfo = async () => {
      try {
        // Find schedule_execution with this run_id
        const executionsRef = collection(db, "schedule_executions");
        const q = query(executionsRef, where("run_id", "==", runId), limit(1));
        const snapshot = await getDocs(q);

        if (!snapshot.empty) {
          const execution = snapshot.docs[0].data();
          const scheduleId = execution.schedule_id;

          if (scheduleId) {
            // Fetch schedule document
            const scheduleRef = doc(db, "schedules", scheduleId);
            const scheduleDoc = await getDoc(scheduleRef);

            if (scheduleDoc.exists()) {
              const scheduleData = scheduleDoc.data();
              setScheduleInfo({
                id: scheduleId,
                name: scheduleData.name || "Unnamed Schedule",
              });
            }
          }
        }
      } catch (error) {
        console.error("Error fetching schedule info:", error);
      }
    };

    fetchScheduleInfo();
  }, [runId, runStatus?.trigger]);

  // Display selected rules from run_config (preferred) or infer from issues (fallback)
  useEffect(() => {
    if (!runId) {
      setRulesUsed([]);
      setLoadingRules(false);
      return;
    }

    setLoadingRules(true);

    // Helper to parse rule_id for navigation
    const parseRuleId = (ruleId: string) => {
      let category = "";
      let entity: string | undefined = undefined;
      let ruleIdForNav = ruleId;

      // Entity pluralization mapping
      const entityPluralMap: Record<string, string> = {
        student: "students",
        students: "students",
        parent: "parents",
        parents: "parents",
        contractor: "contractors",
        contractors: "contractors",
        class: "classes",
        classes: "classes",
        attendance: "attendance",
        truth: "truth",
        payment: "payments",
        payments: "payments",
        data_issue: "data_issues",
        data_issues: "data_issues",
      };

      if (ruleId.startsWith("dup.")) {
        category = "duplicates";
        const parts = ruleId.split(".");
        if (parts.length >= 3) {
          const entitySingular = parts[1];
          entity = entityPluralMap[entitySingular] || entitySingular;
          ruleIdForNav = parts[parts.length - 1];
        }
      } else if (ruleId.startsWith("link.")) {
        category = "relationships";
        const parts = ruleId.split(".");
        if (parts.length >= 2) {
          const entitySingular = parts[1];
          entity = entityPluralMap[entitySingular] || entitySingular;
          ruleIdForNav = parts.slice(2).join(".") || parts[1];
        }
      } else if (ruleId.startsWith("required.")) {
        category = "required_fields";
        const parts = ruleId.split(".");
        if (parts.length >= 3) {
          const entitySingular = parts[1];
          entity = entityPluralMap[entitySingular] || entitySingular;
          const field = parts[2];
          ruleIdForNav = field;
        }
      } else if (
        ruleId.startsWith("attendance.") ||
        ruleId.includes("absence") ||
        ruleId.includes("tardy")
      ) {
        category = "attendance_rules";
        const parts = ruleId.split(".");
        if (parts.length >= 2) {
          ruleIdForNav = parts[1] || ruleId.replace("attendance.", "");
        } else {
          ruleIdForNav = ruleId.replace("attendance.", "");
        }
      }

      return { category, entity, ruleIdForNav };
    };

    // Check if we have run_config with selected rules
    if (runStatus?.run_config?.rules) {
      const ruleMap = new Map<
        string,
        {
          rule_id: string;
          category: string;
          entity?: string;
          ruleId: string;
          displayName: string;
        }
      >();

      const { rules } = runStatus.run_config;

      // Process duplicates
      if (rules.duplicates) {
        Object.entries(rules.duplicates).forEach(([entity, ruleIds]) => {
          ruleIds.forEach((ruleId) => {
            const parsed = parseRuleId(ruleId);
            ruleMap.set(ruleId, {
              rule_id: ruleId,
              category: "duplicates",
              entity,
              ruleId: parsed.ruleIdForNav,
              displayName: formatRuleId(ruleId),
            });
          });
        });
      }

      // Process relationships
      if (rules.relationships) {
        Object.entries(rules.relationships).forEach(([entity, relKeys]) => {
          relKeys.forEach((relKey) => {
            const ruleId = `link.${entity}.${relKey}`;
            const parsed = parseRuleId(ruleId);
            ruleMap.set(ruleId, {
              rule_id: ruleId,
              category: "relationships",
              entity,
              ruleId: parsed.ruleIdForNav,
              displayName: formatRuleId(ruleId),
            });
          });
        });
      }

      // Process required fields
      if (rules.required_fields) {
        Object.entries(rules.required_fields).forEach(([entity, fieldIds]) => {
          fieldIds.forEach((fieldId) => {
            // Handle both formats: "field_name" and "required.entity.field_name"
            const ruleId = fieldId.startsWith("required.") ? fieldId : `required.${entity}.${fieldId}`;
            const parsed = parseRuleId(ruleId);
            ruleMap.set(ruleId, {
              rule_id: ruleId,
              category: "required_fields",
              entity,
              ruleId: parsed.ruleIdForNav,
              displayName: formatRuleId(ruleId),
            });
          });
        });
      }

      // Process attendance rules
      if (rules.attendance_rules === true) {
        const ruleId = "attendance.general";
        ruleMap.set(ruleId, {
          rule_id: ruleId,
          category: "attendance_rules",
          entity: undefined,
          ruleId: "general",
          displayName: "Attendance Rules",
        });
      }

      setRulesUsed(
        Array.from(ruleMap.values()).sort((a, b) =>
          a.displayName.localeCompare(b.displayName)
        )
      );
      setLoadingRules(false);
    } else {
      // Fallback: Infer rules from issues (for old runs without run_config)
      const issuesRef = collection(db, "integrity_issues");
      const q = query(
        issuesRef,
        where("run_id", "==", runId),
        limit(1000)
      );

      const unsubscribe = onSnapshot(
        q,
        (snapshot) => {
          const ruleMap = new Map<
            string,
            {
              rule_id: string;
              category: string;
              entity?: string;
              ruleId: string;
              displayName: string;
            }
          >();

          snapshot.forEach((doc) => {
            const issue = doc.data();
            const ruleId = issue.rule_id;
            if (!ruleId || ruleMap.has(ruleId)) return;

            const parsed = parseRuleId(ruleId);
            if (parsed.category) {
              ruleMap.set(ruleId, {
                rule_id: ruleId,
                category: parsed.category,
                entity: parsed.entity,
                ruleId: parsed.ruleIdForNav,
                displayName: formatRuleId(ruleId),
              });
            }
          });

          setRulesUsed(
            Array.from(ruleMap.values()).sort((a, b) =>
              a.displayName.localeCompare(b.displayName)
            )
          );
          setLoadingRules(false);
        },
        (error) => {
          console.error("Failed to fetch rules:", error);
          setLoadingRules(false);
        }
      );

      return () => unsubscribe();
    }
  }, [runId, runStatus?.run_config]);

  const handleRerun = async () => {
    if (isRerunning || !runStatus) return;
    setIsRerunning(true);
    try {
      const token = await getToken();
      if (!token) {
        alert("Authentication required. Please sign in again.");
        setIsRerunning(false);
        return;
      }

      const params = new URLSearchParams({ trigger: "manual" });
      const runConfig: any = {};

      // Reconstruct config from the original run
      if (runStatus.run_config) {
        if (runStatus.run_config.entities) {
          runConfig.entities = runStatus.run_config.entities;
          runStatus.run_config.entities.forEach((entity: string) => {
            params.append("entities", entity);
          });
        } else if (runStatus.entity_counts) {
          // Fallback: infer entities from entity_counts
          const entities = Object.keys(runStatus.entity_counts);
          runConfig.entities = entities;
          entities.forEach((entity) => params.append("entities", entity));
        }
        if (runStatus.run_config.rules) {
          runConfig.rules = runStatus.run_config.rules;
        }
        if (runStatus.run_config.checks) {
          runConfig.checks = runStatus.run_config.checks;
        }
      } else if (runStatus.entity_counts) {
        const entities = Object.keys(runStatus.entity_counts);
        runConfig.entities = entities;
        entities.forEach((entity) => params.append("entities", entity));
      }

      const requestBody = Object.keys(runConfig).length > 0 ? runConfig : undefined;

      const response = await fetch(
        `${API_BASE}/integrity/run?${params.toString()}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: requestBody ? JSON.stringify(requestBody) : undefined,
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || `Request failed with status ${response.status}`);
      }

      const result = await response.json();
      const newRunId = result.run_id;

      if (newRunId) {
        // Wait for Firestore document to appear
        const checkInterval = 500;
        const maxWait = 30000;
        const startTime = Date.now();

        await new Promise<void>((resolve) => {
          const check = async () => {
            try {
              const runRef = doc(db, "integrity_runs", newRunId);
              const snapshot = await getDoc(runRef);
              if (snapshot.exists() || Date.now() - startTime >= maxWait) {
                resolve();
                return;
              }
              setTimeout(check, checkInterval);
            } catch {
              resolve();
            }
          };
          check();
        });

        navigate(`/run/${newRunId}`);
      } else {
        alert("Scan started but no run ID was returned");
      }
    } catch (error) {
      console.error("Failed to re-run scan:", error);
      let errorMessage = "Failed to start scan. Please try again.";
      if (error instanceof TypeError && error.message.includes("fetch")) {
        errorMessage = "Backend server is not available.";
      } else if (error instanceof Error) {
        errorMessage = error.message;
      }
      alert(errorMessage);
    } finally {
      setIsRerunning(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--brand)] mb-4"></div>
          <p className="text-[var(--text-muted)] mb-2">Loading run status...</p>
          <p className="text-xs text-[var(--text-muted)]">
            {runId
              ? `Run ID: ${runId.substring(0, 8)}...`
              : "Waiting for run to initialize"}
          </p>
        </div>
      </div>
    );
  }

  if (error || !runStatus) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center max-w-md">
          <p className="text-red-600 mb-2 font-medium">
            {error || "Run not found"}
          </p>
          <p className="text-sm text-[var(--text-muted)] mb-4">
            The run may still be initializing. Check the Runs page to see if it
            appears there.
          </p>
          <div className="flex gap-3 justify-center">
            <button
              onClick={() => navigate("/runs")}
              className="rounded-lg border border-[var(--border)] px-4 py-2 text-[var(--text-main)] hover:bg-[var(--bg-mid)] transition-colors"
            >
              View Runs
            </button>
            <button
              onClick={() => navigate("/")}
              className="rounded-lg border border-[var(--border)] px-4 py-2 text-[var(--text-main)] hover:bg-[var(--bg-mid)] transition-colors"
            >
              Dashboard
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Calculate startTime for display (always needed)
  const startTime =
    runStatus.started_at?.toDate?.() ||
    new Date(runStatus.started_at || Date.now());
  const endTime = runStatus.ended_at?.toDate?.() || null;

  // Prefer duration_ms from Firestore if available, otherwise calculate from timestamps
  const elapsed = runStatus.duration_ms
    ? Math.floor(runStatus.duration_ms / 1000)
    : endTime
    ? Math.floor((endTime.getTime() - startTime.getTime()) / 1000)
    : Math.floor((Date.now() - startTime.getTime()) / 1000);

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs}s`;
  };

  const getStatusColor = (status: string) => {
    switch (status?.toLowerCase()) {
      case "success":
      case "healthy":
        return "bg-green-100 text-green-800";
      case "critical":
      case "error":
        return "bg-red-100 text-red-800";
      case "warning":
        return "bg-yellow-100 text-yellow-800";
      case "cancelled":
      case "canceled":
        return "bg-gray-100 text-gray-800";
      case "running":
        return "bg-blue-100 text-blue-800";
      default:
        return "bg-blue-100 text-blue-800";
    }
  };

  const getStatusLabel = (status: string) => {
    switch (status?.toLowerCase()) {
      case "success":
      case "healthy":
        return "Healthy";
      case "critical":
        return "Critical";
      case "error":
        return "Failed";
      case "warning":
        return "Warning";
      case "cancelled":
      case "canceled":
        return "Cancelled";
      case "running":
        return "Running";
      default:
        return "Running";
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1
            className="text-2xl font-semibold text-[var(--text-main)] mb-2"
            style={{ fontFamily: "Outfit" }}
          >
            Run Status
          </h1>
          <p className="text-sm text-[var(--text-muted)]">
            Run ID: {runStatus.id}
          </p>
        </div>
        <div className="flex gap-3">
          <button
            onClick={() => navigate("/runs")}
            className="rounded-lg border border-[var(--border)] px-4 py-2 text-[var(--text-main)] hover:bg-[var(--bg-mid)] transition-colors flex items-center justify-center"
            title="Back to Runs"
          >
            <svg
              className="w-5 h-5"
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
          </button>
          {isRunning && (
            <button
              onClick={async () => {
                if (!runId || isCancelling) return;
                setIsCancelling(true);
                try {
                  const token = await getToken();
                  if (!token) {
                    alert("Authentication required. Please sign in again.");
                    setIsCancelling(false);
                    return;
                  }

                  const response = await fetch(
                    `${API_BASE}/integrity/run/${runId}/cancel`,
                    {
                      method: "POST",
                      headers: {
                        Authorization: `Bearer ${token}`,
                        "Content-Type": "application/json",
                      },
                    }
                  );

                  if (!response.ok) {
                    let errorData;
                    try {
                      errorData = await response.json();
                    } catch {
                      errorData = {
                        error: `Server returned ${response.status}: ${response.statusText}`,
                      };
                    }

                    const errorMessage =
                      errorData.detail?.error ||
                      errorData.detail?.message ||
                      errorData.error ||
                      errorData.message ||
                      `Failed to cancel run (${response.status})`;

                    throw new Error(errorMessage);
                  }

                  // Status will update via real-time subscription
                  // Keep isCancelling true until status actually changes
                } catch (error) {
                  console.error("Failed to cancel run:", error);
                  let errorMessage = "Failed to cancel run. Please try again.";

                  if (
                    error instanceof TypeError &&
                    error.message.includes("fetch")
                  ) {
                    errorMessage =
                      "Backend server is not available. Please ensure the backend is running.";
                  } else if (error instanceof Error) {
                    errorMessage = error.message;
                  }

                  alert(errorMessage);
                  setIsCancelling(false);
                }
              }}
              disabled={isCancelling}
              className="rounded-lg border border-red-500 px-4 py-2 text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isCancelling ? "Cancelling..." : "Cancel Scan"}
            </button>
          )}
          {!isRunning && (
            <button
              onClick={handleRerun}
              disabled={isRerunning}
              className="rounded-lg border border-[var(--brand)] px-4 py-2 text-[var(--brand)] hover:bg-[var(--brand)]/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isRerunning ? "Starting..." : "Re-run Scan"}
            </button>
          )}
          {!isRunning && (
            <button
              onClick={async () => {
                if (!runId || isDeleting) return;

                // First confirmation: Delete run?
                const confirmDelete = window.confirm(
                  "Are you sure you want to delete this run? This action cannot be undone."
                );
                if (!confirmDelete) return;

                // Second confirmation: Delete issues?
                const deleteIssues = window.confirm(
                  "Also delete ALL issues found in this run? This will only delete issues associated with this specific run."
                );

                setIsDeleting(true);
                try {
                  const token = await getToken();
                  if (!token) {
                    alert("Authentication required. Please sign in again.");
                    setIsDeleting(false);
                    return;
                  }

                  const response = await fetch(
                    `${API_BASE}/integrity/run/${runId}?delete_issues=${deleteIssues}`,
                    {
                      method: "DELETE",
                      headers: {
                        Authorization: `Bearer ${token}`,
                        "Content-Type": "application/json",
                      },
                    }
                  );

                  if (!response.ok) {
                    let errorData;
                    try {
                      errorData = await response.json();
                    } catch {
                      errorData = {
                        error: `Server returned ${response.status}: ${response.statusText}`,
                      };
                    }

                    const errorMessage =
                      errorData.detail?.error ||
                      errorData.detail?.message ||
                      errorData.error ||
                      errorData.message ||
                      `Failed to delete run (${response.status})`;

                    throw new Error(errorMessage);
                  }

                  const result = await response.json();
                  const successMessage = deleteIssues && result.deleted_issues_count !== undefined
                    ? `Run deleted successfully. ${result.deleted_issues_count} issues were also deleted.`
                    : "Run deleted successfully.";

                  alert(successMessage);
                  navigate("/runs");
                } catch (error) {
                  console.error("Failed to delete run:", error);
                  let errorMessage = "Failed to delete run. Please try again.";

                  if (
                    error instanceof TypeError &&
                    error.message.includes("fetch")
                  ) {
                    errorMessage =
                      "Backend server is not available. Please ensure the backend is running.";
                  } else if (error instanceof Error) {
                    errorMessage = error.message;
                  }

                  alert(errorMessage);
                  setIsDeleting(false);
                }
              }}
              disabled={isDeleting}
              className="rounded-lg border border-red-500 px-4 py-2 text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isDeleting ? "Deleting..." : "Delete Run"}
            </button>
          )}
        </div>
      </div>

      {/* Status Card */}
      <div className="rounded-2xl border border-[var(--border)] bg-white p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            {isRunning && (
              <div className="inline-block animate-spin rounded-full h-5 w-5 border-b-2 border-[var(--brand)]"></div>
            )}
            <span
              className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium ${getStatusColor(
                runStatus.status
              )}`}
            >
              {getStatusLabel(runStatus.status)}
            </span>
          </div>
          <div className="text-sm text-[var(--text-muted)] text-right">
            <div>Started: {startTime.toLocaleString()}</div>
            {(statusLower === "cancelled" || statusLower === "canceled") &&
              runStatus.cancelled_at && (
                <div className="text-xs mt-1">
                  Cancelled:{" "}
                  {runStatus.cancelled_at?.toDate?.()?.toLocaleString() ||
                    new Date(runStatus.cancelled_at).toLocaleString()}
                </div>
              )}
          </div>
        </div>

        {/* Progress Info */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <div>
            <div className="text-xs text-[var(--text-muted)] mb-1">Trigger</div>
            <div className="font-medium text-[var(--text-main)]">
              {runStatus.trigger === "schedule" && scheduleInfo ? (
                <a
                  href={`/scheduling?scheduleId=${scheduleInfo.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    navigate(`/scheduling?scheduleId=${scheduleInfo.id}`);
                  }}
                  className="text-[var(--cta-blue)] hover:underline cursor-pointer"
                >
                  {scheduleInfo.name}
                </a>
              ) : runStatus.trigger === "manual" ? (
                "Manual Run"
              ) : runStatus.trigger === "nightly" ? (
                "Nightly Scan"
              ) : runStatus.trigger === "weekly" ? (
                "Weekly Scan"
              ) : runStatus.trigger === "schedule" ? (
                "Scheduled Run"
              ) : runStatus.trigger ? (
                runStatus.trigger
                  .split("_")
                  .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
                  .join(" ")
              ) : (
                "Unknown"
              )}
            </div>
          </div>
          <div>
            <div className="text-xs text-[var(--text-muted)] mb-1">
              Duration
            </div>
            <div className="font-medium text-[var(--text-main)]">
              {formatDuration(elapsed)}
            </div>
          </div>
        </div>

        {/* Entity Counts */}
        {runStatus.entity_counts &&
          Object.keys(runStatus.entity_counts).length > 0 && (
            <div className="mb-6">
              <div className="text-sm font-medium text-[var(--text-main)] mb-3">
                Records Processed
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {Object.entries(runStatus.entity_counts).map(
                  ([entity, count]) => (
                    <div
                      key={entity}
                      className="rounded-lg border border-[var(--border)] p-3 bg-[var(--bg-mid)]/30"
                    >
                      <div className="text-xs text-[var(--text-muted)] mb-1 capitalize">
                        {entity}
                      </div>
                      <div className="text-lg font-semibold text-[var(--text-main)]">
                        {count.toLocaleString()}
                      </div>
                    </div>
                  )
                )}
              </div>
            </div>
          )}

        {/* New Issues Count */}
        <div className="mb-6">
          <div className="text-sm font-medium text-[var(--text-main)] mb-3">
            New Issues Found
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="rounded-lg border border-[var(--border)] p-4 bg-[var(--bg-mid)]/30">
              <div className="text-xs text-[var(--text-muted)] mb-1">Total</div>
              <div className="text-2xl font-semibold text-[var(--text-main)]">
                {(() => {
                  // Calculate total from severity counts to ensure it matches displayed values
                  const critical = runStatus.new_issues_by_severity?.critical || 0;
                  const warning = runStatus.new_issues_by_severity?.warning || 0;
                  const info = runStatus.new_issues_by_severity?.info || 0;
                  return critical + warning + info;
                })()}
              </div>
            </div>
            <div className="rounded-lg border border-red-200 p-4 bg-red-50">
              <div className="text-xs text-red-700 mb-1">Critical</div>
              <div className="text-2xl font-semibold text-red-800">
                {runStatus.new_issues_by_severity?.critical || 0}
              </div>
            </div>
            <div className="rounded-lg border border-yellow-200 p-4 bg-yellow-50">
              <div className="text-xs text-yellow-700 mb-1">Warning</div>
              <div className="text-2xl font-semibold text-yellow-800">
                {runStatus.new_issues_by_severity?.warning || 0}
              </div>
            </div>
            <div className="rounded-lg border border-blue-200 p-4 bg-blue-50">
              <div className="text-xs text-blue-700 mb-1">Info</div>
              <div className="text-2xl font-semibold text-blue-800">
                {runStatus.new_issues_by_severity?.info || 0}
              </div>
            </div>
          </div>
        </div>

        {/* Issue Counts */}
        {runStatus.counts && (
          <div className="mb-6">
            <div className="text-sm font-medium text-[var(--text-main)] mb-3">
              Total Issues Found
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="rounded-lg border border-[var(--border)] p-4 bg-[var(--bg-mid)]/30">
                <div className="text-xs text-[var(--text-muted)] mb-1">
                  Total
                </div>
                <div className="text-2xl font-semibold text-[var(--text-main)]">
                  {(() => {
                    // Calculate total from severity counts to ensure it matches displayed values
                    const critical = runStatus.counts.by_severity?.critical || 0;
                    const warning = runStatus.counts.by_severity?.warning || 0;
                    const info = runStatus.counts.by_severity?.info || 0;
                    return critical + warning + info;
                  })()}
                </div>
              </div>
              {runStatus.counts.by_severity && (
                <>
                  <div className="rounded-lg border border-red-200 p-4 bg-red-50">
                    <div className="text-xs text-red-700 mb-1">Critical</div>
                    <div className="text-2xl font-semibold text-red-800">
                      {runStatus.counts.by_severity.critical || 0}
                    </div>
                  </div>
                  <div className="rounded-lg border border-yellow-200 p-4 bg-yellow-50">
                    <div className="text-xs text-yellow-700 mb-1">Warning</div>
                    <div className="text-2xl font-semibold text-yellow-800">
                      {runStatus.counts.by_severity.warning || 0}
                    </div>
                  </div>
                  <div className="rounded-lg border border-blue-200 p-4 bg-blue-50">
                    <div className="text-xs text-blue-700 mb-1">Info</div>
                    <div className="text-2xl font-semibold text-blue-800">
                      {runStatus.counts.by_severity.info || 0}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* Error Message */}
        {runStatus.error_message && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 mb-4">
            <div className="text-sm font-medium text-red-800 mb-2">Error</div>
            <div className="text-sm text-red-700">
              {runStatus.error_message}
            </div>
          </div>
        )}

        {/* Failed Checks */}
        {runStatus.failed_checks && runStatus.failed_checks.length > 0 && (
          <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-4">
            <div className="text-sm font-medium text-yellow-800 mb-2">
              Failed Checks
            </div>
            <div className="text-sm text-yellow-700">
              {runStatus.failed_checks.join(", ")}
            </div>
          </div>
        )}

        {/* Timing Breakdown */}
        {(runStatus.duration_fetch ||
          runStatus.duration_checks ||
          runStatus.duration_write_airtable ||
          runStatus.duration_write_firestore) && (
          <div className="mt-6 pt-6 border-t border-[var(--border)]">
            <div className="text-sm font-medium text-[var(--text-main)] mb-3">
              Timing Breakdown
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              {runStatus.duration_fetch && (
                <div>
                  <div className="text-[var(--text-muted)]">Fetch</div>
                  <div className="font-medium text-[var(--text-main)]">
                    {(runStatus.duration_fetch / 1000).toFixed(1)}s
                  </div>
                </div>
              )}
              {runStatus.duration_checks && (
                <div>
                  <div className="text-[var(--text-muted)]">Checks</div>
                  <div className="font-medium text-[var(--text-main)]">
                    {(runStatus.duration_checks / 1000).toFixed(1)}s
                  </div>
                </div>
              )}
              {runStatus.duration_write_airtable && (
                <div>
                  <div className="text-[var(--text-muted)]">Write Airtable</div>
                  <div className="font-medium text-[var(--text-main)]">
                    {(runStatus.duration_write_airtable / 1000).toFixed(1)}s
                  </div>
                </div>
              )}
              {runStatus.duration_write_firestore && (
                <div>
                  <div className="text-[var(--text-muted)]">
                    Write Firestore
                  </div>
                  <div className="font-medium text-[var(--text-main)]">
                    {(runStatus.duration_write_firestore / 1000).toFixed(1)}s
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Slack Notifications & Rules Used */}
        <div className="mt-6 pt-6 border-t border-[var(--border)]">
          <div className="flex items-center justify-between mb-3">
            <div className="text-sm font-medium text-[var(--text-main)]">
              Rules Selected for This Scan
              {runStatus?.run_config?.rules && (
                <span className="ml-2 text-xs font-normal text-[var(--text-muted)]">
                  ({rulesUsed.length} {rulesUsed.length === 1 ? 'rule' : 'rules'} selected)
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5 text-xs">
              <span className="text-[var(--text-muted)]">Slack:</span>
              {runStatus?.run_config?.notify_slack ? (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium">
                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                  Enabled
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 font-medium">
                  Disabled
                </span>
              )}
            </div>
          </div>
          {loadingRules ? (
            <div className="text-xs text-[var(--text-muted)]">
              Loading rules...
            </div>
          ) : rulesUsed.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {rulesUsed.map((rule) => {
                // Build navigation path to rules page with entity highlight
                let navPath = "";
                if (rule.entity) {
                  navPath = `/rules?entity=${rule.entity}`;
                } else if (rule.category === "attendance_rules") {
                  navPath = `/rules?entity=attendance`;
                }

                return (
                  <a
                    key={rule.rule_id}
                    href={navPath}
                    onClick={(e) => {
                      e.preventDefault();
                      if (navPath) {
                        navigate(navPath);
                      }
                    }}
                    className={`inline-flex items-center px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                      navPath
                        ? "bg-[var(--bg-mid)] text-[var(--text-main)] hover:bg-[var(--bg-mid)]/80 cursor-pointer border border-[var(--border)]"
                        : "bg-gray-100 text-gray-600 cursor-default"
                    }`}
                    title={rule.rule_id}
                  >
                    {rule.displayName}
                    {navPath && (
                      <svg
                        className="ml-1.5 w-3 h-3"
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
                    )}
                  </a>
                );
              })}
            </div>
          ) : (
            <div className="text-xs text-[var(--text-muted)]">
              {isRunning
                ? "Rules will appear here as issues are discovered..."
                : "No rules found in this scan."}
            </div>
          )}
        </div>
      </div>

      {/* Current Step Progress Indicator */}
      {/* {isRunning && (
        <div className="rounded-2xl border border-[var(--border)] bg-white p-6 mb-6">
          <div className="mb-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-[var(--text-main)]">
                Current Step
              </span>
              <span className="inline-flex items-center gap-2 text-xs text-[var(--text-muted)]">
                <span className="inline-block h-2 w-2 rounded-full bg-[var(--brand)] animate-pulse"></span>
                Live updates enabled
              </span>
            </div>
            <div className="text-sm text-[var(--text-muted)]">
              {logs.length > 0
                ? logs[0]?.message || "Initializing..."
                : "Waiting for logs..."}
            </div>
          </div>
          {(() => {
            const latestLog =
              logs.length > 0 ? logs[0]?.message?.toLowerCase() || "" : "";
            let progress = 0;
            let stageLabel = "Initializing";

            if (
              latestLog.includes("discovering") ||
              latestLog.includes("discovered")
            ) {
              stageLabel = "Discovering table IDs";
              progress = 10;
            } else if (
              latestLog.includes("fetching") ||
              latestLog.includes("fetched")
            ) {
              if (latestLog.includes("students")) {
                stageLabel = "Fetching students";
                progress = 25;
              } else if (latestLog.includes("parents")) {
                stageLabel = "Fetching parents";
                progress = 30;
              } else if (latestLog.includes("classes")) {
                stageLabel = "Fetching classes";
                progress = 35;
              } else {
                stageLabel = "Fetching records";
                progress = 30;
              }
            } else if (
              latestLog.includes("running") ||
              latestLog.includes("check")
            ) {
              if (latestLog.includes("duplicates")) {
                stageLabel = "Checking for duplicates";
                progress = 45;
              } else if (latestLog.includes("links")) {
                stageLabel = "Checking links";
                progress = 60;
              } else if (latestLog.includes("required")) {
                stageLabel = "Checking required fields";
                progress = 75;
              } else if (latestLog.includes("attendance")) {
                stageLabel = "Checking attendance";
                progress = 85;
              } else {
                stageLabel = "Running integrity checks";
                progress = 50;
              }
            } else if (
              latestLog.includes("writing") ||
              latestLog.includes("wrote")
            ) {
              if (latestLog.includes("firestore")) {
                stageLabel = "Writing to Firestore";
                progress = 90;
              } else if (latestLog.includes("airtable")) {
                stageLabel = "Writing to Airtable";
                progress = 95;
              } else {
                stageLabel = "Writing results";
                progress = 92;
              }
            } else if (
              latestLog.includes("completed") ||
              latestLog.includes("complete")
            ) {
              stageLabel = "Completed";
              progress = 100;
            } else if (latestLog.includes("started")) {
              stageLabel = "Starting scan";
              progress = 5;
            }

            return (
              <div className="space-y-2">
                <div className="w-full bg-[var(--bg-mid)] rounded-full h-2">
                  <div
                    className="bg-[var(--brand)] h-2 rounded-full transition-all duration-300"
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <div className="text-xs text-[var(--text-muted)] text-center">
                  {stageLabel}
                </div>
              </div>
            );
          })()}
        </div>
      )} */}

      {/* Issues from This Run */}
      {(!isRunning ||
        statusLower === "cancelled" ||
        statusLower === "canceled") &&
        runId && (
          <div className="rounded-2xl border border-[var(--border)] bg-white p-6 mb-6">
            <div className="flex items-center justify-between mb-4">
              <h2
                className="text-lg font-semibold text-[var(--text-main)]"
                style={{ fontFamily: "Outfit" }}
              >
                Issues from This Run
              </h2>
            </div>
            {/* Tabs */}
            <div className="flex gap-2 mb-4 border-b border-[var(--border)]">
              <button
                onClick={() => setActiveIssueTab("new")}
                className={`px-4 py-2 text-sm font-medium transition-colors ${
                  activeIssueTab === "new"
                    ? "text-[var(--cta-blue)] border-b-2 border-[var(--cta-blue)]"
                    : "text-[var(--text-muted)] hover:text-[var(--text-main)]"
                }`}
              >
                New Issues
              </button>
              <button
                onClick={() => setActiveIssueTab("all")}
                className={`px-4 py-2 text-sm font-medium transition-colors ${
                  activeIssueTab === "all"
                    ? "text-[var(--cta-blue)] border-b-2 border-[var(--cta-blue)]"
                    : "text-[var(--text-muted)] hover:text-[var(--text-main)]"
                }`}
              >
                All Issues
              </button>
            </div>
            {/* Tab Content */}
            {activeIssueTab === "new" ? (
              <IssueList
                key={`new-issues-${runId}`}
                filters={{
                  run_id: runId,
                  first_seen_in_run: runId,
                  status: "all",
                }}
                totalItems={runStatus.new_issues_count || 0}
                itemsPerPage={50}
              />
            ) : (
              <IssueList
                key={`all-issues-${runId}`}
                filters={{ run_id: runId, status: "all" }}
                totalItems={runStatus.counts?.total || 0}
                itemsPerPage={50}
              />
            )}
            {/* Debug info */}
            <div className="text-xs text-gray-400 mt-2">
              Debug: runId = {runId || "undefined"}
            </div>
          </div>
        )}

      {/* API Access Snippet */}
      {runId && !isRunning && (
        <div className="rounded-2xl border border-[var(--border)] bg-white overflow-hidden">
          <button
            onClick={() => setShowApiSnippet(!showApiSnippet)}
            className="w-full flex items-center justify-between p-5 hover:bg-gray-50/50 transition-colors"
          >
            <div className="flex items-center gap-3">
              <svg className="w-5 h-5 text-[var(--text-muted)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
              </svg>
              <span className="text-sm font-semibold text-[var(--text-main)]" style={{ fontFamily: "Outfit" }}>
                API Access
              </span>
              <span className="text-xs text-[var(--text-muted)]">
                Fetch record IDs from this run programmatically
              </span>
            </div>
            <svg
              className={`w-4 h-4 text-[var(--text-muted)] transition-transform ${showApiSnippet ? "rotate-180" : ""}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {showApiSnippet && (
            <div className="px-5 pb-5 border-t border-[var(--border)]">
              <p className="text-xs text-[var(--text-muted)] mt-4 mb-3">
                Use an API key from your{" "}
                <a
                  href="/api-keys"
                  onClick={(e) => { e.preventDefault(); navigate("/api-keys"); }}
                  className="text-[var(--cta-blue)] hover:underline"
                >
                  API Keys page
                </a>
                {" "}or the static API_AUTH_TOKEN.
              </p>
              {/* Language tabs */}
              <div className="flex gap-1 mb-3">
                {(["curl", "python", "js"] as const).map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setSnippetTab(tab)}
                    className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                      snippetTab === tab
                        ? "bg-[var(--brand)] text-white"
                        : "bg-gray-100 text-[var(--text-muted)] hover:bg-gray-200"
                    }`}
                  >
                    {tab === "curl" ? "cURL" : tab === "python" ? "Python" : "JavaScript"}
                  </button>
                ))}
              </div>
              {/* Code block */}
              <div className="relative">
                <button
                  onClick={async () => {
                    const code = document.getElementById("api-snippet-code")?.textContent || "";
                    await navigator.clipboard.writeText(code);
                    setSnippetCopied(true);
                    setTimeout(() => setSnippetCopied(false), 2000);
                  }}
                  className="absolute top-2 right-2 rounded-md bg-white/80 px-2 py-1 text-xs font-medium text-[var(--text-muted)] hover:bg-white hover:text-[var(--text-main)] border border-[var(--border)] transition-colors z-10"
                >
                  {snippetCopied ? "Copied" : "Copy"}
                </button>
                <pre
                  id="api-snippet-code"
                  className="bg-[var(--bg-dark)] rounded-lg border border-[var(--border)] p-4 pr-20 font-mono text-xs text-[var(--text-main)] overflow-x-auto whitespace-pre"
                >
                  {snippetTab === "curl" && `curl -X GET \\
  "${API_BASE}/integrity/run/${runId}/record-ids" \\
  -H "Authorization: Bearer YOUR_API_KEY"`}
                  {snippetTab === "python" && `import requests

response = requests.get(
    "${API_BASE}/integrity/run/${runId}/record-ids",
    headers={"Authorization": "Bearer YOUR_API_KEY"}
)
data = response.json()

# Response shape:
# {
#   "run_id": "${runId}",
#   "entities": {
#     "students": {
#       "count": 5,
#       "records": [
#         {
#           "record_id": "recABC123",
#           "issues": [
#             {
#               "issue_type": "duplicate",
#               "severity": "warning",
#               "rule_id": "dup.student.name_dob",
#               "description": "..."
#             }
#           ]
#         }
#       ]
#     }
#   },
#   "total_records": 12,
#   "total_issues": 18
# }

for entity, info in data["entities"].items():
    print(f"{entity}: {info['count']} records")
    for record in info["records"]:
        print(f"  {record['record_id']}: {len(record['issues'])} issues")`}
                  {snippetTab === "js" && `const response = await fetch(
  "${API_BASE}/integrity/run/${runId}/record-ids",
  {
    headers: { "Authorization": "Bearer YOUR_API_KEY" }
  }
);
const data = await response.json();

// data.entities.<entity>.records[] has record_id + issues
for (const [entity, info] of Object.entries(data.entities)) {
  console.log(\`\${entity}: \${info.count} records\`);
  for (const record of info.records) {
    console.log(\`  \${record.record_id}: \${record.issues.length} issues\`);
  }
}`}
                </pre>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Real-time Logs */}
      <div className="rounded-2xl border border-[var(--border)] bg-white p-6">
        <div className="flex items-center justify-between mb-4">
          <h2
            className="text-lg font-semibold text-[var(--text-main)]"
            style={{ fontFamily: "Outfit" }}
          >
            Real-time Logs
          </h2>
          {logsLoading && (
            <div className="text-sm text-[var(--text-muted)]">
              Loading logs...
            </div>
          )}
        </div>

        <div
          ref={logsContainerRef}
          onScroll={handleLogsScroll}
          className="bg-[var(--bg-dark)] rounded-lg border border-[var(--border)] p-4 font-mono text-sm max-h-[600px] overflow-y-auto"
        >
          {logs.length === 0 && !logsLoading && (
            <div className="text-[var(--text-muted)] text-center py-8">
              No logs available yet
            </div>
          )}
          {[...logs].reverse().map((log) => {
            const timestamp =
              log.timestamp?.toDate?.() ||
              new Date(log.timestamp || Date.now());
            const timeStr = timestamp.toLocaleTimeString();
            const levelColor =
              {
                info: "text-blue-600",
                warning: "text-yellow-600",
                error: "text-red-600",
                debug: "text-gray-500",
              }[log.level] || "text-[var(--text-muted)]";

            return (
              <div key={log.id} className="mb-2 flex gap-3">
                <span className="text-[var(--text-muted)] text-xs whitespace-nowrap">
                  {timeStr}
                </span>
                <span
                  className={`font-semibold ${levelColor} uppercase text-xs`}
                >
                  {log.level}
                </span>
                <span className="text-[var(--text-main)] flex-1">
                  {log.message}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
