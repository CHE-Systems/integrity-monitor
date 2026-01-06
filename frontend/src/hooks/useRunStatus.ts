import { useEffect, useState, useRef } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "../config/firebase";

export interface RunStatus {
  id: string;
  run_id?: string;
  status: "running" | "success" | "error" | "warning" | "timeout" | "cancelled" | "failed" | "critical";
  started_at?: any;
  ended_at?: any;
  cancelled_at?: any;
  duration_ms?: number;
  mode?: string;
  trigger?: string;
  entity_counts?: Record<string, number>;
  counts?: {
    total?: number;
    by_type?: Record<string, number>;
    by_severity?: Record<string, number>;
  };
  new_issues_count?: number;
  new_issues_by_severity?: Record<string, number>;
  error_message?: string;
  failed_checks?: string[];
  duration_fetch?: number;
  duration_checks?: number;
  duration_write_airtable?: number;
  duration_write_firestore?: number;
  run_config?: {
    entities?: string[];
    rules?: {
      duplicates?: Record<string, string[]>;
      relationships?: Record<string, string[]>;
      required_fields?: Record<string, string[]>;
      attendance_rules?: boolean;
    };
  };
}

const MAX_WAIT_TIME = 30000; // 30 seconds max wait

export function useRunStatus(runId: string | null) {
  const [runStatus, setRunStatus] = useState<RunStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const previousRunIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!runId) {
      setLoading(false);
      setRunStatus(null);
      setError(null);
      previousRunIdRef.current = null;
      return;
    }

    // Don't reset state if runId hasn't changed and we already have valid data
    // This prevents flickering and false "Run not found" errors on remount
    const runIdChanged = previousRunIdRef.current !== runId;
    previousRunIdRef.current = runId;

    if (!runIdChanged && runStatus && (runStatus.id === runId || runStatus.run_id === runId)) {
      // Same runId and we already have data - keep existing state, just set up listener for updates
      setLoading(false);
      setError(null);
    } else {
      // New runId or no data yet - reset state
      setLoading(true);
      setError(null);
      if (runIdChanged) {
        setRunStatus(null);
      }
    }

    const runRef = doc(db, "integrity_runs", runId);
    const startTime = Date.now();
    let errorTimeout: NodeJS.Timeout | null = null;

    const unsubscribe = onSnapshot(
      runRef,
      (snapshot) => {
        const elapsed = Date.now() - startTime;

        console.log(`[useRunStatus] Snapshot for runId ${runId}:`, {
          exists: snapshot.exists(),
          elapsed: `${Math.floor(elapsed / 1000)}s`,
          data: snapshot.exists() ? snapshot.data() : null,
        });

        if (snapshot.exists()) {
          // Clear any pending error timeout
          if (errorTimeout) {
            clearTimeout(errorTimeout);
            errorTimeout = null;
          }

          const data = snapshot.data();
          const newStatus = {
            id: snapshot.id,
            ...data,
          } as RunStatus;
          // #region agent log
          fetch('http://127.0.0.1:7242/ingest/5d5f825f-e8a4-412f-af68-47be30198b26', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: 'useRunStatus.ts:87', message: 'Status update received from Firestore', data: { runId, status: newStatus.status, ended_at: newStatus.ended_at, cancelled_at: newStatus.cancelled_at }, timestamp: Date.now(), sessionId: 'debug-session', runId: 'status-update', hypothesisId: 'H5' }) }).catch(() => { });
          // #endregion agent log
          setRunStatus(newStatus);
          setLoading(false);
          setError(null);
        } else {
          // Document doesn't exist yet - might be a new run
          // Keep loading state and wait for document to appear
          // onSnapshot will automatically fire when document is created
          setLoading(true);

          // Only show error after max wait time
          if (elapsed < MAX_WAIT_TIME) {
            console.log(`[useRunStatus] Run ${runId} not found yet, waiting... (elapsed: ${Math.floor(elapsed / 1000)}s)`);
            // Clear any existing timeout
            if (errorTimeout) {
              clearTimeout(errorTimeout);
            }
            // Set a timeout to show error if document doesn't appear
            errorTimeout = setTimeout(() => {
              const finalElapsed = Date.now() - startTime;
              if (finalElapsed >= MAX_WAIT_TIME) {
                console.error(`[useRunStatus] Run ${runId} not found after ${Math.floor(finalElapsed / 1000)}s`);
                setError("Run not found. The run may still be initializing. Please check the Runs page to see if it appears there.");
                setLoading(false);
              }
            }, MAX_WAIT_TIME - elapsed);
          } else {
            console.error(`[useRunStatus] Run ${runId} not found after ${Math.floor(elapsed / 1000)}s`);
            setError("Run not found. The run may still be initializing. Please check the Runs page to see if it appears there.");
            setLoading(false);
          }
        }
      },
      (err) => {
        console.error("Error fetching run status:", err);
        setError(err.message || "Failed to load run status");
        setLoading(false);
      }
    );

    return () => {
      unsubscribe();
      if (errorTimeout) {
        clearTimeout(errorTimeout);
      }
    };
  }, [runId]);

  return { runStatus, loading, error };
}
