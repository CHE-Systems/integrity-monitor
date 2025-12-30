import { useState, useEffect, useMemo, type ReactNode } from "react";
import { NavLink, useNavigate, useSearchParams } from "react-router-dom";
import "./App.css";
import { ProfileMenu } from "./components/ProfileMenu";
import { ScanConfigModal, type ScanConfig } from "./components/ScanConfigModal";
import { useAuth } from "./hooks/useAuth";
import { useRunStatus } from "./hooks/useRunStatus";
import { useFirestoreRuns } from "./hooks/useFirestoreRuns";
import { ToastContainer } from "./components/Toast";
import { AirtableSchemaProvider } from "./contexts/AirtableSchemaContext";
import databaseSearchIcon from "./assets/database_search.svg";

import { API_BASE } from "./config/api";

interface AppProps {
  children: ReactNode;
}

export default function App({ children }: AppProps) {
  const { getToken } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: runs, loading: runsLoading } = useFirestoreRuns(1);

  // Toast notification state
  const [toasts, setToasts] = useState<
    Array<{ id: string; message: string; type: "success" | "error" | "info" }>
  >([]);
  const addToast = (message: string, type: "success" | "error" | "info") => {
    const id = Date.now().toString() + Math.random().toString(36).substr(2, 9);
    setToasts((prev) => [...prev, { id, message, type }]);
  };
  const removeToast = (id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  // Run scan state
  const [runScanLoading, setRunScanLoading] = useState(false);
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const [lastScanTime, setLastScanTime] = useState<number | null>(null);
  const [scanConfigOpen, setScanConfigOpen] = useState(false);
  const MIN_SCAN_INTERVAL = 30000; // 30 seconds

  // Monitor current run status
  const { runStatus } = useRunStatus(currentRunId);

  // Update loading state and clear currentRunId when run completes
  useEffect(() => {
    if (runStatus) {
      if (runStatus.status === "running" || !runStatus.ended_at) {
        setRunScanLoading(true);
      } else {
        // Run has completed - clear loading state and currentRunId immediately
        setRunScanLoading(false);
        if (
          currentRunId === runStatus.id ||
          currentRunId === runStatus.run_id
        ) {
          setCurrentRunId(null);
        }
      }
    }
  }, [runStatus, currentRunId]);

  // Handle run scan button click - opens modal directly
  const handleRunScanClick = () => {
    // Check rate limiting
    const now = Date.now();
    if (lastScanTime && now - lastScanTime < MIN_SCAN_INTERVAL) {
      const remainingSeconds = Math.ceil(
        (MIN_SCAN_INTERVAL - (now - lastScanTime)) / 1000
      );
      addToast(
        `Please wait ${remainingSeconds} seconds before running another scan`,
        "info"
      );
      return;
    }
    // Open modal directly without navigating
    setScanConfigOpen(true);
  };

  // Check for openScanModal query param and open modal
  useEffect(() => {
    if (searchParams.get("openScanModal") === "true") {
      setScanConfigOpen(true);
      // Remove the query param from URL
      const newSearchParams = new URLSearchParams(searchParams);
      newSearchParams.delete("openScanModal");
      setSearchParams(newSearchParams, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  // Wait for Firestore document to be created using real-time listener
  const waitForRunDocument = async (
    runId: string,
    maxWait = 30000
  ): Promise<void> => {
    const { doc, onSnapshot } = await import("firebase/firestore");
    const { db } = await import("./config/firebase");
    const startTime = Date.now();

    return new Promise((resolve) => {
      const runRef = doc(db, "integrity_runs", runId);
      let unsubscribe: (() => void) | null = null;

      // Set up timeout to resolve after maxWait even if document doesn't appear
      const timeout = setTimeout(() => {
        if (unsubscribe) {
          unsubscribe();
        }
        console.log(
          `[App] Run document not found after ${maxWait}ms, navigating anyway`
        );
        resolve();
      }, maxWait);

      // Use onSnapshot for real-time updates - fires immediately when document is created
      unsubscribe = onSnapshot(
        runRef,
        (snapshot) => {
          if (snapshot.exists()) {
            clearTimeout(timeout);
            if (unsubscribe) {
              unsubscribe();
            }
            console.log(
              `[App] Run document found after ${Date.now() - startTime}ms`
            );
            resolve();
          }
        },
        (error) => {
          // On error, resolve anyway and let the page handle it
          clearTimeout(timeout);
          if (unsubscribe) {
            unsubscribe();
          }
          console.error("[App] Error waiting for run document:", error);
          resolve();
        }
      );
    });
  };

  // Execute scan with configuration
  const executeScan = async (config: ScanConfig) => {
    setScanConfigOpen(false);
    setRunScanLoading(true);
    try {
      const token = await getToken();
      if (!token) {
        addToast("Authentication required. Please sign in.", "error");
        setRunScanLoading(false);
        return;
      }

      // Build query parameters
      const params = new URLSearchParams({
        trigger: "manual",
      });

      // Add entities if specified
      if (config.entities && config.entities.length > 0) {
        config.entities.forEach((entity) => {
          params.append("entities", entity);
        });
      }

      // #region agent log
      fetch(
        "http://127.0.0.1:7242/ingest/5d5f825f-e8a4-412f-af68-47be30198b26",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            location: "App.tsx:107",
            message: "Before fetch request",
            data: {
              url: `${API_BASE}/integrity/run?${params.toString()}`,
              hasToken: !!token,
            },
            timestamp: Date.now(),
            sessionId: "debug-session",
            runId: "fetch-attempt",
            hypothesisId: "C",
          }),
        }
      ).catch(() => {});
      // #endregion agent log

      // Build run_config with entities, rules, and checks
      const runConfig: any = {};
      if (config.entities && config.entities.length > 0) {
        runConfig.entities = config.entities;
      }
      if (config.rules) {
        runConfig.rules = config.rules;
      }
      if (config.checks) {
        runConfig.checks = config.checks;
      }

      // DEBUG LOGGING: Show what's being sent to backend
      console.log("=".repeat(80));
      console.log("FRONTEND: Starting Scan - Config Being Sent");
      console.log("=".repeat(80));
      console.log("Config from modal:", JSON.stringify(config, null, 2));
      console.log("Run config to send:", JSON.stringify(runConfig, null, 2));
      console.log("=".repeat(80));

      // Build request body - send runConfig directly as the body
      // FastAPI's Body(default=None) will receive this as the run_config parameter
      const requestBody =
        Object.keys(runConfig).length > 0 ? runConfig : undefined;

      console.log("Request body:", JSON.stringify(requestBody, null, 2));
      console.log("=".repeat(80));

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
      ).catch((error) => {
        // #region agent log
        fetch(
          "http://127.0.0.1:7242/ingest/5d5f825f-e8a4-412f-af68-47be30198b26",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              location: "App.tsx:117",
              message: "Fetch error caught",
              data: {
                error: error.message,
                errorType: error.name,
                errorStack: error.stack,
              },
              timestamp: Date.now(),
              sessionId: "debug-session",
              runId: "fetch-attempt",
              hypothesisId: "C",
            }),
          }
        ).catch(() => {});
        // #endregion agent log
        throw error;
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          errorText || `Request failed with status ${response.status}`
        );
      }

      const result = await response.json();
      const runId = result.run_id;

      console.log("[App] Scan started, response:", result);
      console.log("[App] Run ID:", runId);

      if (runId) {
        setCurrentRunId(runId);
        addToast("Integrity scan started successfully", "success");
        // Wait for the Firestore document to be created before navigating
        await waitForRunDocument(runId);
        console.log("[App] Navigating to run status page:", `/run/${runId}`);
        navigate(`/run/${runId}`);
      } else {
        console.warn("[App] No run_id in response:", result);
        addToast("Integrity scan started successfully", "success");
      }

      setLastScanTime(Date.now());
    } catch (error) {
      addToast(
        error instanceof Error
          ? error.message
          : "Failed to start integrity scan",
        "error"
      );
      setRunScanLoading(false);
    }
  };

  // Handle clicking on Running button
  const handleRunningClick = () => {
    // Use lastRunInfo.runId if available (same as the working "Last run" button)
    // Otherwise fall back to currentRunId
    const runId = lastRunInfo?.runId || currentRunId;
    if (runId) {
      navigate(`/run/${runId}`);
    }
  };

  // Get last run info for status display
  const lastRunInfo = useMemo(() => {
    if (runsLoading || !runs || runs.length === 0) {
      return null;
    }

    const lastRun = runs[0];
    const runTime =
      lastRun.started_at?.toDate?.() || lastRun.ended_at?.toDate?.() || null;

    if (!runTime) {
      return null;
    }

    const now = new Date();
    const diffMs = now.getTime() - runTime.getTime();
    const diffHours = diffMs / (1000 * 60 * 60);
    const diffDays = diffMs / (1000 * 60 * 60 * 24);

    let timeDisplay: string;
    if (diffHours < 1) {
      const diffMins = Math.floor(diffMs / (1000 * 60));
      timeDisplay = diffMins < 1 ? "Just now" : `${diffMins}m ago`;
    } else if (diffHours < 24) {
      timeDisplay = `${Math.floor(diffHours)}h ago`;
    } else if (diffDays < 7) {
      timeDisplay = `${Math.floor(diffDays)}d ago`;
    } else {
      // Show date and time for older runs
      timeDisplay =
        runTime.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        }) +
        " " +
        runTime.toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
        });
    }

    // Map status to display text and color
    const statusText = lastRun.status || "Unknown";
    const statusLower = statusText.toLowerCase();

    // Format status text for display
    let displayStatus = statusText;
    if (statusLower === "cancelled" || statusLower === "canceled") {
      displayStatus = "Cancelled";
    } else if (statusLower === "healthy") {
      displayStatus = "Healthy";
    } else if (statusLower === "success") {
      displayStatus = "Success";
    } else if (statusLower === "critical") {
      displayStatus = "Critical";
    } else if (statusLower === "failed" || statusLower === "error") {
      displayStatus = "Failed";
    } else if (statusLower === "warning") {
      displayStatus = "Warning";
    } else if (statusLower === "running") {
      displayStatus = "Running";
    }

    const statusColor =
      statusLower === "critical" ||
      statusLower === "failed" ||
      statusLower === "error"
        ? "bg-red-500"
        : statusLower === "warning"
        ? "bg-yellow-500"
        : statusLower === "running"
        ? "bg-blue-500"
        : statusLower === "cancelled" || statusLower === "canceled"
        ? "bg-gray-500"
        : statusLower === "success" || statusLower === "healthy"
        ? "bg-[var(--brand)]"
        : "bg-[var(--brand)]";

    return {
      time: timeDisplay,
      status: displayStatus,
      statusColor,
      runId: lastRun.run_id || lastRun.id,
    };
  }, [runs, runsLoading]);
  return (
    <div className="min-h-screen bg-[var(--bg-warm-light)] text-[var(--text-main)]">
      <AirtableSchemaProvider>
        <header className="border-b border-[var(--border)] bg-[var(--bg-light)]/90">
          <div className="mx-auto flex max-w-6xl flex-col gap-2 px-6 py-3 md:flex-row md:items-center md:justify-between">
            <div className="flex items-center gap-2 flex-1">
              <div className="flex items-center gap-2">
                <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[var(--brand)]">
                  <img
                    src={databaseSearchIcon}
                    alt="Database Search"
                    className="w-6 h-6 brightness-0 invert"
                  />
                </div>
                <div>
                  <p
                    className="font-semibold tracking-tight"
                    style={{ fontFamily: "Outfit" }}
                  >
                    Data Integrity Monitor
                  </p>
                </div>
              </div>
              <nav className="ml-2">
                <div className="inline-flex rounded-full border border-[var(--border)] bg-white/80 p-1 text-sm">
                  <NavLink
                    to="/"
                    end
                    className={({ isActive }) =>
                      `rounded-full px-4 py-1.5 font-medium transition-colors ${
                        isActive
                          ? "bg-[var(--brand)] text-white"
                          : "text-[var(--text-muted)] hover:text-[var(--text-main)]"
                      }`
                    }
                  >
                    Overview
                  </NavLink>
                  <NavLink
                    to="/admin"
                    className={({ isActive }) =>
                      `rounded-full px-4 py-1.5 font-medium transition-colors ${
                        isActive
                          ? "bg-[var(--brand)] text-white"
                          : "text-[var(--text-muted)] hover:text-[var(--text-main)]"
                      }`
                    }
                  >
                    Admin
                  </NavLink>
                  <NavLink
                    to="/runs"
                    className={({ isActive }) =>
                      `rounded-full px-4 py-1.5 font-medium transition-colors ${
                        isActive
                          ? "bg-[var(--brand)] text-white"
                          : "text-[var(--text-muted)] hover:text-[var(--text-main)]"
                      }`
                    }
                  >
                    Runs
                  </NavLink>
                  <NavLink
                    to="/issues"
                    className={({ isActive }) =>
                      `rounded-full px-4 py-1.5 font-medium transition-colors ${
                        isActive
                          ? "bg-[var(--brand)] text-white"
                          : "text-[var(--text-muted)] hover:text-[var(--text-main)]"
                      }`
                    }
                  >
                    Issues
                  </NavLink>
                  <NavLink
                    to="/schema"
                    className={({ isActive }) =>
                      `rounded-full px-4 py-1.5 font-medium transition-colors ${
                        isActive
                          ? "bg-[var(--brand)] text-white"
                          : "text-[var(--text-muted)] hover:text-[var(--text-main)]"
                      }`
                    }
                  >
                    Schema
                  </NavLink>
                </div>
              </nav>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--text-muted)]">
              {runsLoading ? (
                <div className="inline-flex items-center gap-2 rounded-full border border-[var(--border)] bg-white/70 px-3 py-1">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--border)] animate-pulse" />
                  Loading...
                </div>
              ) : lastRunInfo ? (
                <button
                  onClick={() => navigate(`/run/${lastRunInfo.runId}`)}
                  className="inline-flex items-center gap-2 rounded-full border border-[var(--border)] bg-white/70 px-3 py-1 hover:bg-white/90 transition-colors cursor-pointer"
                >
                  <span
                    className={`inline-block h-1.5 w-1.5 rounded-full ${lastRunInfo.statusColor}`}
                  />
                  Last run {lastRunInfo.time} • {lastRunInfo.status}
                </button>
              ) : (
                <div className="inline-flex items-center gap-2 rounded-full border border-[var(--border)] bg-white/70 px-3 py-1">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--border)]" />
                  No runs yet
                </div>
              )}
              <div className="flex gap-1.5 items-center">
                {runScanLoading && currentRunId ? (
                  <button
                    onClick={handleRunningClick}
                    className="rounded-full border border-[var(--brand)] px-4 py-1.5 text-[var(--brand)] font-medium hover:bg-[var(--brand)]/5 transition-colors flex items-center gap-2"
                  >
                    <span className="inline-block h-2 w-2 rounded-full bg-[var(--brand)] animate-pulse"></span>
                    Running...
                  </button>
                ) : (
                  <button
                    onClick={handleRunScanClick}
                    disabled={runScanLoading}
                    className="rounded-full border border-[var(--brand)] px-4 py-1.5 text-[var(--brand)] font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:bg-[var(--brand)]/5 transition-colors flex items-center justify-center gap-2"
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      height="16px"
                      viewBox="0 -960 960 960"
                      width="16px"
                      className="w-4 h-4 flex-shrink-0"
                      fill="var(--brand)"
                    >
                      <path d="M200-800v241-1 400-640 200-200Zm0 720q-33 0-56.5-23.5T120-160v-640q0-33 23.5-56.5T200-880h320l240 240v100q-19-8-39-12.5t-41-6.5v-41H480v-200H200v640h241q16 24 36 44.5T521-80H200Zm460-120q42 0 71-29t29-71q0-42-29-71t-71-29q-42 0-71 29t-29 71q0 42 29 71t71 29ZM864-40 756-148q-21 14-45.5 21t-50.5 7q-75 0-127.5-52.5T480-300q0-75 52.5-127.5T660-480q75 0 127.5 52.5T840-300q0 26-7 50.5T812-204L920-96l-56 56Z" />
                    </svg>
                    {runScanLoading ? "Starting..." : ""}
                  </button>
                )}
                <NavLink
                  to="/reports"
                  className={({ isActive }) =>
                    `rounded-full border border-[var(--border)] bg-white px-4 py-1.5 font-medium text-[var(--text-main)] hover:bg-[var(--bg-mid)] transition-colors flex items-center gap-2 ${
                      isActive ? "bg-[var(--bg-mid)]" : ""
                    }`
                  }
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    height="16px"
                    viewBox="0 -960 960 960"
                    width="16px"
                    className="w-4 h-4 flex-shrink-0"
                    fill="var(--brand)"
                  >
                    <path d="M280-280h80v-200h-80v200Zm320 0h80v-400h-80v400Zm-160 0h80v-120h-80v120Zm0-200h80v-80h-80v80ZM200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h560q33 0 56.5 23.5T840-760v560q0 33-23.5 56.5T760-120H200Zm0-80h560v-560H200v560Zm0-560v560-560Z" />
                  </svg>
                </NavLink>
                <NavLink
                  to="/scheduling"
                  className={({ isActive }) =>
                    `rounded-full border border-[var(--border)] bg-white px-4 py-1.5 font-medium text-[var(--text-main)] hover:bg-[var(--bg-mid)] transition-colors flex items-center gap-2 ${
                      isActive ? "bg-[var(--bg-mid)]" : ""
                    }`
                  }
                  title="Scheduling"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    height="24px"
                    viewBox="0 -960 960 960"
                    width="24px"
                    className="w-4 h-4 flex-shrink-0"
                    fill="var(--brand)"
                  >
                    <path d="M200-640h560v-80H200v80Zm0 0v-80 80Zm0 560q-33 0-56.5-23.5T120-160v-560q0-33 23.5-56.5T200-800h40v-80h80v80h320v-80h80v80h40q33 0 56.5 23.5T840-720v227q-19-9-39-15t-41-9v-43H200v400h252q7 22 16.5 42T491-80H200Zm520 40q-83 0-141.5-58.5T520-240q0-83 58.5-141.5T720-440q83 0 141.5 58.5T920-240q0 83-58.5 141.5T720-40Zm67-105 28-28-75-75v-112h-40v128l87 87Z" />
                  </svg>
                </NavLink>
                <ProfileMenu />
              </div>
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-6xl px-6 py-10 space-y-10">
          {children}
        </main>

        {/* Toast notifications */}
        <ToastContainer toasts={toasts} onRemove={removeToast} />

        {/* Scan configuration modal */}
        <ScanConfigModal
          isOpen={scanConfigOpen}
          onConfirm={executeScan}
          onCancel={() => setScanConfigOpen(false)}
        />
      </AirtableSchemaProvider>
    </div>
  );
}
