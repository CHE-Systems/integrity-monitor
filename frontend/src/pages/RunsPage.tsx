import { useNavigate } from "react-router-dom";
import { useFirestoreRuns } from "../hooks/useFirestoreRuns";
import { useState, useMemo, useEffect } from "react";
import { useAuth } from "../hooks/useAuth";
import {
  ScanConfigModal,
  type ScanConfig,
} from "../components/ScanConfigModal";
import { IssueList } from "../components/IssueList";
import { Pagination } from "../components/Pagination";
import { API_BASE } from "../config/api";
import cancelButtonIcon from "../assets/cancel_button.svg";

const RUNS_PER_PAGE = 25;

export function RunsPage() {
  const navigate = useNavigate();
  const { data: runs, loading, error } = useFirestoreRuns(1000);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const { getToken } = useAuth();
  const [deletingRunId, setDeletingRunId] = useState<string | null>(null);
  const [cancellingRunId, setCancellingRunId] = useState<string | null>(null);
  const [scanConfigOpen, setScanConfigOpen] = useState(false);
  const [cancellingAll, setCancellingAll] = useState(false);
  const [deletingAll, setDeletingAll] = useState(false);

  // Filter state
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [triggerFilter, setTriggerFilter] = useState("all");
  const [durationFilter, setDurationFilter] = useState("all");
  const [startDate, setStartDate] = useState<string>("");
  const [endDate, setEndDate] = useState<string>("");
  const [currentPage, setCurrentPage] = useState(1);

  // Reset to page 1 when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [
    searchQuery,
    statusFilter,
    triggerFilter,
    durationFilter,
    startDate,
    endDate,
  ]);

  // Filter and paginate runs
  const { filteredRuns, paginatedRuns, totalPages, startIndex, endIndex } =
    useMemo(() => {
      let filtered = [...runs];

      // Search filter (case-insensitive)
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase();
        filtered = filtered.filter((run) => {
          const runId = (run.run_id || run.id || "").toLowerCase();
          const trigger = (run.trigger || "").toLowerCase();
          const status = (run.status || "").toLowerCase();
          return (
            runId.includes(query) ||
            trigger.includes(query) ||
            status.includes(query)
          );
        });
      }

      // Status filter
      if (statusFilter !== "all") {
        filtered = filtered.filter((run) => {
          const status = (run.status || "").toLowerCase();
          const statusLower = statusFilter.toLowerCase();
          if (statusLower === "healthy") {
            return status === "healthy" || status === "success";
          }
          if (statusLower === "cancelled") {
            return status === "cancelled" || status === "canceled";
          }
          return status === statusLower;
        });
      }

      // Trigger filter
      if (triggerFilter !== "all") {
        filtered = filtered.filter((run) => {
          const trigger = (run.trigger || "").toLowerCase();
          return trigger === triggerFilter.toLowerCase();
        });
      }

      // Duration filter
      if (durationFilter !== "all") {
        filtered = filtered.filter((run) => {
          if (!run.duration_ms) return false;
          const minutes = run.duration_ms / 60000;

          switch (durationFilter) {
            case "<1m":
              return minutes < 1;
            case "1-5m":
              return minutes >= 1 && minutes < 5;
            case "5-15m":
              return minutes >= 5 && minutes < 15;
            case "15-30m":
              return minutes >= 15 && minutes < 30;
            case ">30m":
              return minutes >= 30;
            default:
              return true;
          }
        });
      }

      // Date range filter
      if (startDate) {
        const start = new Date(startDate);
        start.setHours(0, 0, 0, 0);
        filtered = filtered.filter((run) => {
          if (!run.started_at) return false;
          const runDate =
            run.started_at?.toDate?.() || new Date(run.started_at);
          runDate.setHours(0, 0, 0, 0);
          return runDate >= start;
        });
      }

      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        filtered = filtered.filter((run) => {
          if (!run.started_at) return false;
          const runDate =
            run.started_at?.toDate?.() || new Date(run.started_at);
          return runDate <= end;
        });
      }

      // Pagination
      const total = Math.ceil(filtered.length / RUNS_PER_PAGE) || 1;
      const start = (currentPage - 1) * RUNS_PER_PAGE;
      const end = start + RUNS_PER_PAGE;
      const paginated = filtered.slice(start, end);

      return {
        filteredRuns: filtered,
        paginatedRuns: paginated,
        totalPages: total,
        startIndex: start,
        endIndex: end,
      };
    }, [
      runs,
      searchQuery,
      statusFilter,
      triggerFilter,
      durationFilter,
      startDate,
      endDate,
      currentPage,
    ]);

  const clearFilters = () => {
    setSearchQuery("");
    setStatusFilter("all");
    setTriggerFilter("all");
    setDurationFilter("all");
    setStartDate("");
    setEndDate("");
    setCurrentPage(1);
  };

  const hasActiveFilters = useMemo(() => {
    return (
      searchQuery.trim() !== "" ||
      statusFilter !== "all" ||
      triggerFilter !== "all" ||
      durationFilter !== "all" ||
      startDate !== "" ||
      endDate !== ""
    );
  }, [
    searchQuery,
    statusFilter,
    triggerFilter,
    durationFilter,
    startDate,
    endDate,
  ]);

  const handleCancel = async (runId: string) => {
    if (!runId || cancellingRunId) return;

    setCancellingRunId(runId);
    try {
      const token = await getToken();
      if (!token) {
        alert("Authentication required. Please sign in again.");
        setCancellingRunId(null);
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
    } catch (error) {
      console.error("Failed to cancel run:", error);
      let errorMessage = "Failed to cancel run. Please try again.";

      if (error instanceof TypeError && error.message.includes("fetch")) {
        errorMessage =
          "Backend server is not available. Please ensure the backend is running.";
      } else if (error instanceof Error) {
        errorMessage = error.message;
      }

      alert(errorMessage);
    } finally {
      setCancellingRunId(null);
    }
  };

  const handleDelete = async (runId: string) => {
    if (
      !confirm(
        "Are you sure you want to delete this run? This action cannot be undone."
      )
    ) {
      return;
    }

    setDeletingRunId(runId);
    try {
      const token = await getToken();
      const response = await fetch(`${API_BASE}/integrity/run/${runId}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        const errorData = await response
          .json()
          .catch(() => ({ error: "Failed to delete run" }));
        throw new Error(errorData.error || "Failed to delete run");
      }

      // The Firestore subscription will automatically update the list
    } catch (error) {
      console.error("Failed to delete run:", error);
      let errorMessage = "Unknown error";
      if (error instanceof TypeError && error.message.includes("fetch")) {
        errorMessage =
          "Backend server is not available. Please ensure the backend is running.";
      } else if (error instanceof Error) {
        errorMessage = error.message;
      }
      alert(`Failed to delete run: ${errorMessage}`);
    } finally {
      setDeletingRunId(null);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status.toLowerCase()) {
      case "healthy":
      case "success":
        return "bg-green-100 text-green-800 border-green-200";
      case "critical":
      case "error":
        return "bg-red-100 text-red-800 border-red-200";
      case "warning":
        return "bg-yellow-100 text-yellow-800 border-yellow-200";
      case "cancelled":
      case "canceled":
        return "bg-gray-100 text-gray-800 border-gray-200";
      case "running":
        return "bg-blue-100 text-blue-800 border-blue-200";
      default:
        return "bg-blue-100 text-blue-800 border-blue-200";
    }
  };

  const formatTimestamp = (timestamp: any) => {
    if (!timestamp) return "N/A";
    const date = timestamp?.toDate?.() || new Date(timestamp);
    return date.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  };

  const getTriggerLabel = (trigger: string) => {
    if (trigger === "manual") return "Manual";
    if (trigger === "nightly") return "Nightly";
    if (trigger === "weekly") return "Weekly";
    return trigger || "Unknown";
  };

  const handleRunScan = () => {
    setScanConfigOpen(true);
  };

  const handleCancelAll = async () => {
    if (
      !confirm(
        "Are you sure you want to cancel all currently running scans? This action cannot be undone."
      )
    ) {
      return;
    }

    setCancellingAll(true);
    try {
      const token = await getToken();
      if (!token) {
        alert("Authentication required. Please sign in again.");
        setCancellingAll(false);
        return;
      }

      const response = await fetch(`${API_BASE}/integrity/runs/cancel-all`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        const errorData = await response
          .json()
          .catch(() => ({ error: "Failed to cancel all runs" }));
        throw new Error(
          errorData.error ||
            errorData.detail?.error ||
            "Failed to cancel all runs"
        );
      }

      const result = await response.json();
      alert(
        `Successfully cancelled ${result.cancelled_count || 0} running scan(s).`
      );
    } catch (error) {
      console.error("Failed to cancel all runs:", error);
      let errorMessage = "Unknown error";
      if (error instanceof TypeError && error.message.includes("fetch")) {
        errorMessage =
          "Backend server is not available. Please ensure the backend is running.";
      } else if (error instanceof Error) {
        errorMessage = error.message;
      }
      alert(`Failed to cancel all runs: ${errorMessage}`);
    } finally {
      setCancellingAll(false);
    }
  };

  const handleDeleteAll = async () => {
    if (
      !confirm(
        "Are you sure you want to delete ALL runs? This action cannot be undone and will delete all scan history."
      )
    ) {
      return;
    }

    if (
      !confirm(
        "This is your final warning. Are you absolutely sure you want to delete ALL runs?"
      )
    ) {
      return;
    }

    setDeletingAll(true);
    try {
      const token = await getToken();
      if (!token) {
        alert("Authentication required. Please sign in again.");
        setDeletingAll(false);
        return;
      }

      const response = await fetch(`${API_BASE}/integrity/runs/all`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        const errorData = await response
          .json()
          .catch(() => ({ error: "Failed to delete all runs" }));
        throw new Error(
          errorData.error ||
            errorData.detail?.error ||
            "Failed to delete all runs"
        );
      }

      const result = await response.json();
      alert(`Successfully deleted ${result.deleted_count || 0} run(s).`);
    } catch (error) {
      console.error("Failed to delete all runs:", error);
      let errorMessage = "Unknown error";
      if (error instanceof TypeError && error.message.includes("fetch")) {
        errorMessage =
          "Backend server is not available. Please ensure the backend is running.";
      } else if (error instanceof Error) {
        errorMessage = error.message;
      }
      alert(`Failed to delete all runs: ${errorMessage}`);
    } finally {
      setDeletingAll(false);
    }
  };

  const executeScan = async (config: ScanConfig) => {
    setScanConfigOpen(false);
    try {
      const token = await getToken();
      if (!token) {
        alert("Authentication required. Please sign in.");
        return;
      }

      const params = new URLSearchParams({
        trigger: "manual",
      });

      // Build run_config with entities, rules, and checks
      const runConfig: any = {};
      if (config.entities && config.entities.length > 0) {
        runConfig.entities = config.entities;
        // Also add to query params for backward compatibility
        config.entities.forEach((entity) => {
          params.append("entities", entity);
        });
      }
      if (config.rules) {
        runConfig.rules = config.rules;
      }
      if (config.checks) {
        runConfig.checks = config.checks;
      }

      // Build request body - send runConfig directly as the body
      // FastAPI's Body(default=None) will receive this as the run_config parameter
      const requestBody =
        Object.keys(runConfig).length > 0 ? runConfig : undefined;

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
        throw new Error(
          errorText || `Request failed with status ${response.status}`
        );
      }

      const result = await response.json();
      const runId = result.run_id;

      if (runId) {
        // Wait for the Firestore document to be created before navigating
        await waitForRunDocument(runId);
        navigate(`/run/${runId}`);
      } else {
        alert("Scan started but no run ID was returned");
      }
    } catch (error) {
      console.error("Failed to start scan:", error);
      let errorMessage = "Unknown error";
      if (error instanceof TypeError && error.message.includes("fetch")) {
        errorMessage =
          "Backend server is not available. Please ensure the backend is running.";
      } else if (error instanceof Error) {
        errorMessage = error.message;
      }
      alert(`Failed to start scan: ${errorMessage}`);
    }
  };

  // Wait for Firestore document to be created
  const waitForRunDocument = async (
    runId: string,
    maxWait = 30000
  ): Promise<void> => {
    const { doc, getDoc } = await import("firebase/firestore");
    const { db } = await import("../config/firebase");
    const checkInterval = 500;
    const startTime = Date.now();

    console.log(
      `[RunsPage] Starting to wait for run document: ${runId} (maxWait: ${maxWait}ms)`
    );

    return new Promise((resolve) => {
      const checkDocument = async () => {
        try {
          const runRef = doc(db, "integrity_runs", runId);
          const snapshot = await getDoc(runRef);
          const elapsed = Date.now() - startTime;
          const exists = snapshot.exists();

          console.log(
            `[RunsPage] Polling check: exists=${exists}, elapsed=${elapsed}ms`
          );

          if (exists) {
            console.log(`[RunsPage] Run document found after ${elapsed}ms`);
            resolve();
            return;
          }

          if (elapsed >= maxWait) {
            // Document still doesn't exist after maxWait, but navigate anyway
            // The useRunStatus hook will handle retrying
            console.log(
              `[RunsPage] Timeout reached after ${elapsed}ms, navigating anyway`
            );
            resolve();
            return;
          }

          setTimeout(checkDocument, checkInterval);
        } catch (error) {
          // On error, resolve anyway and let the page handle it
          console.error("[RunsPage] Error checking for run document:", error);
          resolve();
        }
      };

      checkDocument();
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--brand)] mb-4"></div>
          <p className="text-[var(--text-muted)]">Loading runs...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <p className="text-red-600 mb-4">{error}</p>
          <button
            onClick={() => navigate("/")}
            className="rounded-lg border border-[var(--border)] px-4 py-2 text-[var(--text-main)] hover:bg-[var(--bg-mid)] transition-colors"
          >
            Back to Dashboard
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1
            className="text-2xl font-semibold text-[var(--text-main)] mb-2"
            style={{ fontFamily: "Outfit" }}
          >
            Runs
          </h1>
          <p className="text-sm text-[var(--text-muted)]">
            View status and log details for all integrity scans
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleCancelAll}
            disabled={cancellingAll}
            className="rounded-lg bg-yellow-600 px-4 py-2 text-white font-medium hover:bg-yellow-700 transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {cancellingAll ? (
              <>
                <svg
                  className="animate-spin h-5 w-5"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  ></circle>
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  ></path>
                </svg>
                Cancelling...
              </>
            ) : (
              <>
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  height="20px"
                  viewBox="0 -960 960 960"
                  width="20px"
                  className="w-5 h-5 flex-shrink-0"
                  fill="currentColor"
                >
                  <path d="M280-120v-520h-80v-280h360l80 80v200h80v280h-80v280H280Zm80-400h200v-200H360v200Zm0 320h200v-200H360v200Z" />
                </svg>
                Cancel All Running
              </>
            )}
          </button>
          <button
            onClick={handleDeleteAll}
            disabled={deletingAll}
            className="rounded-lg bg-red-600 px-4 py-2 text-white font-medium hover:bg-red-700 transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {deletingAll ? (
              <>
                <svg
                  className="animate-spin h-5 w-5"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  ></circle>
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  ></path>
                </svg>
                Deleting...
              </>
            ) : (
              <>
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  height="20px"
                  viewBox="0 -960 960 960"
                  width="20px"
                  className="w-5 h-5 flex-shrink-0"
                  fill="currentColor"
                >
                  <path d="M280-120q-33 0-56.5-23.5T200-200v-520h-40v-80h200v-40h240v40h200v80h-40v520q0 33-23.5 56.5T680-120H280Zm400-600H280v520h400v-520ZM360-280h80v-360h-80v360Zm160 0h80v-360h-80v360ZM280-720v520-520Z" />
                </svg>
                Delete All Runs
              </>
            )}
          </button>
          <button
            onClick={handleRunScan}
            className="rounded-lg bg-[var(--brand)] px-4 py-2 text-white font-medium hover:bg-[var(--brand)]/90 transition-colors flex items-center gap-2"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              height="20px"
              viewBox="0 -960 960 960"
              width="20px"
              className="w-5 h-5 flex-shrink-0"
              fill="currentColor"
            >
              <path d="M200-800v241-1 400-640 200-200Zm0 720q-33 0-56.5-23.5T120-160v-640q0-33 23.5-56.5T200-880h320l240 240v100q-19-8-39-12.5t-41-6.5v-41H480v-200H200v640h241q16 24 36 44.5T521-80H200Zm460-120q42 0 71-29t29-71q0-42-29-71t-71-29q-42 0-71 29t-29 71q0 42 29 71t71 29ZM864-40 756-148q-21 14-45.5 21t-50.5 7q-75 0-127.5-52.5T480-300q0-75 52.5-127.5T660-480q75 0 127.5 52.5T840-300q0 26-7 50.5T812-204L920-96l-56 56Z" />
            </svg>
            Run Scan
          </button>
        </div>
      </div>

      {/* Filter Section */}
      <div className="bg-white border border-[var(--border)] rounded-xl p-4 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-[var(--text-main)]">
            Filters
          </h2>
          {hasActiveFilters && (
            <button
              onClick={clearFilters}
              className="text-sm text-[var(--text-muted)] hover:text-[var(--text-main)] transition-colors"
            >
              Clear all filters
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {/* Search Input */}
          <div>
            <label className="block text-sm font-medium text-[var(--text-main)] mb-2">
              Search
            </label>
            <input
              type="text"
              placeholder="Search by run ID, trigger, or status..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-[var(--text-main)]"
            />
          </div>

          {/* Status Filter */}
          <div>
            <label className="block text-sm font-medium text-[var(--text-main)] mb-2">
              Status
            </label>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="w-full rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-[var(--text-main)]"
            >
              <option value="all">All Statuses</option>
              <option value="Healthy">Healthy</option>
              <option value="Error">Error</option>
              <option value="Warning">Warning</option>
              <option value="Critical">Critical</option>
              <option value="Running">Running</option>
              <option value="Cancelled">Cancelled</option>
            </select>
          </div>

          {/* Trigger Filter */}
          <div>
            <label className="block text-sm font-medium text-[var(--text-main)] mb-2">
              Trigger
            </label>
            <select
              value={triggerFilter}
              onChange={(e) => setTriggerFilter(e.target.value)}
              className="w-full rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-[var(--text-main)]"
            >
              <option value="all">All Triggers</option>
              <option value="manual">Manual</option>
              <option value="nightly">Nightly</option>
              <option value="weekly">Weekly</option>
              <option value="schedule">Schedule</option>
            </select>
          </div>

          {/* Duration Filter */}
          <div>
            <label className="block text-sm font-medium text-[var(--text-main)] mb-2">
              Duration
            </label>
            <select
              value={durationFilter}
              onChange={(e) => setDurationFilter(e.target.value)}
              className="w-full rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-[var(--text-main)]"
            >
              <option value="all">All Durations</option>
              <option value="<1m">&lt;1 minute</option>
              <option value="1-5m">1-5 minutes</option>
              <option value="5-15m">5-15 minutes</option>
              <option value="15-30m">15-30 minutes</option>
              <option value=">30m">&gt;30 minutes</option>
            </select>
          </div>

          {/* Start Date */}
          <div>
            <label className="block text-sm font-medium text-[var(--text-main)] mb-2">
              Start Date
            </label>
            <div className="flex gap-2">
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="flex-1 rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-[var(--text-main)]"
              />
              {startDate && (
                <button
                  onClick={() => setStartDate("")}
                  className="px-2 text-[var(--text-muted)] hover:text-[var(--text-main)]"
                  title="Clear start date"
                >
                  ×
                </button>
              )}
            </div>
          </div>

          {/* End Date */}
          <div>
            <label className="block text-sm font-medium text-[var(--text-main)] mb-2">
              End Date
            </label>
            <div className="flex gap-2">
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="flex-1 rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-[var(--text-main)]"
              />
              {endDate && (
                <button
                  onClick={() => setEndDate("")}
                  className="px-2 text-[var(--text-muted)] hover:text-[var(--text-main)]"
                  title="Clear end date"
                >
                  ×
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Results count */}
        <div className="text-sm text-[var(--text-muted)] pt-2 border-t border-[var(--border)]">
          Showing {filteredRuns.length}{" "}
          {filteredRuns.length === 1 ? "run" : "runs"}
          {hasActiveFilters && ` (filtered from ${runs.length} total)`}
        </div>
      </div>

      {runs.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-[var(--text-muted)]">No runs found.</p>
          <p className="text-sm text-[var(--text-muted)] mt-2">
            Run a scan to generate your first run.
          </p>
        </div>
      ) : filteredRuns.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-[var(--text-muted)]">
            No runs match your filters.
          </p>
          <p className="text-sm text-[var(--text-muted)] mt-2">
            Try adjusting your search criteria or{" "}
            <button
              onClick={clearFilters}
              className="text-[var(--brand)] hover:underline"
            >
              clear all filters
            </button>
            .
          </p>
        </div>
      ) : (
        <div className="bg-white border border-[var(--border)] rounded-xl p-6 space-y-4">
          {/* Pagination Controls - Top */}
          <Pagination
            currentPage={currentPage}
            totalPages={totalPages}
            totalItems={filteredRuns.length}
            itemsPerPage={RUNS_PER_PAGE}
            startIndex={startIndex}
            endIndex={endIndex}
            onPageChange={setCurrentPage}
            itemLabel="runs"
          />

          <div className="space-y-2">
            {paginatedRuns.map((run) => {
              const isExpanded = expandedRun === run.id;
              const startTime =
                run.started_at?.toDate?.() ||
                new Date(run.started_at || Date.now());
              const endTime = run.ended_at?.toDate?.() || null;
              const statusLower = (run.status || "").toLowerCase();
              const isRunning =
                (!endTime || run.status === "running") &&
                statusLower !== "cancelled" &&
                statusLower !== "canceled" &&
                statusLower !== "success" &&
                statusLower !== "error" &&
                statusLower !== "warning" &&
                statusLower !== "healthy" &&
                statusLower !== "critical";

              return (
                <div
                  key={run.id}
                  className="rounded-xl border border-[var(--border)] bg-white overflow-hidden"
                >
                  <div
                    className="p-4 cursor-pointer hover:bg-[var(--bg-mid)]/30 transition-colors"
                    onClick={() => setExpandedRun(isExpanded ? null : run.id)}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-4 flex-1">
                        <div className="flex-1">
                          <div className="flex items-center gap-3 mb-2">
                            <span
                              className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${getStatusColor(
                                run.status
                              )}`}
                            >
                              {statusLower === "cancelled" ||
                              statusLower === "canceled"
                                ? "Cancelled"
                                : run.status}
                            </span>
                            {isRunning && (
                              <span className="inline-block h-2 w-2 rounded-full bg-[var(--brand)] animate-pulse"></span>
                            )}
                            <span className="text-sm text-[var(--text-muted)]">
                              {formatTimestamp(run.started_at)}
                            </span>
                          </div>
                          <div className="flex items-center gap-4 text-sm text-[var(--text-muted)]">
                            <span>
                              Trigger: {getTriggerLabel(run.trigger || "")}
                            </span>
                            <span>Duration: {run.duration}</span>
                            {run.run_id && (
                              <span className="font-mono text-xs">
                                ID: {run.run_id.substring(0, 8)}...
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-4">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (run.run_id) {
                              navigate(`/run/${run.run_id}`);
                            }
                          }}
                          className="rounded-full border border-[var(--brand)] px-4 py-1.5 text-sm font-medium text-[var(--brand)] hover:bg-[var(--brand)]/5 transition-colors flex items-center gap-2"
                        >
                          View Details
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
                              d="M9 5l7 7-7 7"
                            />
                          </svg>
                        </button>
                        {isRunning && (run.run_id || run.id) && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleCancel(run.run_id || run.id);
                            }}
                            disabled={
                              cancellingRunId === (run.run_id || run.id)
                            }
                            className="text-sm text-red-600 hover:text-red-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
                            title="Cancel run"
                          >
                            {cancellingRunId === (run.run_id || run.id) ? (
                              "Cancelling..."
                            ) : (
                              <img
                                src={cancelButtonIcon}
                                alt="Cancel"
                                className="w-4 h-4"
                                style={{
                                  filter:
                                    "brightness(0) saturate(100%) invert(27%) sepia(96%) saturate(2598%) hue-rotate(340deg) brightness(97%) contrast(95%)",
                                }}
                              />
                            )}
                          </button>
                        )}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (run.run_id || run.id) {
                              handleDelete(run.run_id || run.id);
                            }
                          }}
                          disabled={deletingRunId === (run.run_id || run.id)}
                          className="text-sm text-red-600 hover:text-red-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
                          title="Delete run"
                        >
                          {deletingRunId === (run.run_id || run.id) ? (
                            "Deleting..."
                          ) : (
                            <>
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
                                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                                />
                              </svg>
                              Delete
                            </>
                          )}
                        </button>
                        <svg
                          className={`w-5 h-5 text-[var(--text-muted)] transition-transform ${
                            isExpanded ? "rotate-180" : ""
                          }`}
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
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
                    <div className="border-t border-[var(--border)] bg-[var(--bg-mid)]/20 p-4 space-y-4">
                      {/* Status Details and Issues Found - Side by Side */}
                      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                        {/* Status Details */}
                        <div>
                          <h3 className="text-sm font-semibold text-[var(--text-main)] mb-2">
                            Status Details
                          </h3>
                          <div className="grid grid-cols-2 gap-3 text-sm">
                            <div>
                              <div className="text-[var(--text-muted)] text-xs mb-1">
                                Started
                              </div>
                              <div className="text-[var(--text-main)] font-medium">
                                {formatTimestamp(run.started_at)}
                              </div>
                            </div>
                            {endTime && (
                              <div>
                                <div className="text-[var(--text-muted)] text-xs mb-1">
                                  Ended
                                </div>
                                <div className="text-[var(--text-main)] font-medium">
                                  {formatTimestamp(run.ended_at)}
                                </div>
                              </div>
                            )}
                            <div>
                              <div className="text-[var(--text-muted)] text-xs mb-1">
                                Duration
                              </div>
                              <div className="text-[var(--text-main)] font-medium">
                                {run.duration_ms
                                  ? `${Math.floor(
                                      run.duration_ms / 60000
                                    )}m ${Math.floor(
                                      (run.duration_ms % 60000) / 1000
                                    )}s`
                                  : run.duration}
                              </div>
                            </div>
                            <div>
                              <div className="text-[var(--text-muted)] text-xs mb-1">
                                Run ID
                              </div>
                              <div className="text-[var(--text-main)] font-mono text-xs">
                                {run.run_id || run.id}
                              </div>
                            </div>
                          </div>
                        </div>

                        {/* Issues Found */}
                        {!isRunning &&
                          statusLower !== "cancelled" &&
                          statusLower !== "canceled" && (
                            <div>
                              <h3 className="text-sm font-semibold text-[var(--text-main)] mb-2">
                                Issues Found
                                {run.counts?.total !== undefined && (
                                  <span className="ml-2 text-[var(--text-muted)] font-normal">
                                    ({run.counts.total.toLocaleString()})
                                  </span>
                                )}
                              </h3>
                              <div className="bg-white rounded-lg border border-[var(--border)] max-h-[400px] overflow-y-auto">
                                <IssueList
                                  filters={{
                                    run_id: run.run_id || run.id,
                                    status: "open",
                                  }}
                                />
                              </div>
                            </div>
                          )}
                      </div>

                      {/* Log Details */}
                      <div>
                        <h3 className="text-sm font-semibold text-[var(--text-main)] mb-2">
                          Log Details
                        </h3>
                        <div className="bg-white rounded-lg border border-[var(--border)] p-3 font-mono text-xs">
                          <div className="space-y-1">
                            <div className="text-[var(--text-muted)]">
                              <span className="text-blue-600">[INFO]</span> Run
                              started: {formatTimestamp(run.started_at)}
                            </div>
                            <div className="text-[var(--text-muted)]">
                              <span className="text-blue-600">[INFO]</span>{" "}
                              Trigger: {getTriggerLabel(run.trigger || "")}
                            </div>
                            {endTime && (
                              <div className="text-[var(--text-muted)]">
                                <span className="text-green-600">[INFO]</span>{" "}
                                Run completed: {formatTimestamp(run.ended_at)}
                              </div>
                            )}
                            {run.status === "error" && (
                              <div className="text-red-600">
                                <span className="text-red-600">[ERROR]</span>{" "}
                                Run failed
                              </div>
                            )}
                            {run.status === "critical" && (
                              <div className="text-red-600">
                                <span className="text-red-600">[CRITICAL]</span>{" "}
                                Critical issues found
                              </div>
                            )}
                            {run.status === "warning" && (
                              <div className="text-yellow-600">
                                <span className="text-yellow-600">[WARN]</span>{" "}
                                Run completed with warnings
                              </div>
                            )}
                            {(run.status === "success" ||
                              run.status === "Healthy") && (
                              <div className="text-green-600">
                                <span className="text-green-600">
                                  [SUCCESS]
                                </span>{" "}
                                Run completed successfully
                              </div>
                            )}
                            {(statusLower === "cancelled" ||
                              statusLower === "canceled") && (
                              <div className="text-gray-600">
                                <span className="text-gray-600">
                                  [CANCELLED]
                                </span>{" "}
                                Run was cancelled
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Scan configuration modal */}
      <ScanConfigModal
        isOpen={scanConfigOpen}
        onConfirm={executeScan}
        onCancel={() => setScanConfigOpen(false)}
      />
    </div>
  );
}
