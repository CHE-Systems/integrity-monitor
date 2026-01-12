import { useState } from "react";
import { useIntegrityMetrics } from "../hooks/useIntegrityMetrics";
import { RunDetailModal } from "../components/RunDetailModal";
import type { RunHistoryItem } from "../hooks/useFirestoreRuns";
import { DashboardContent } from "../components/DashboardContent";

export function AdminDashboardPage() {
  const integrityMetrics = useIntegrityMetrics();

  // Selected queue and run for modals
  const [selectedQueue, setSelectedQueue] = useState<{
    type?: string;
    entity?: string;
  } | null>(null);
  const [selectedRun, setSelectedRun] = useState<RunHistoryItem | null>(null);

  return (
    <>
      <DashboardContent
        integrityMetrics={integrityMetrics}
        onRunScan={() => {}}
        runScanLoading={false}
        selectedQueue={selectedQueue}
        onSelectQueue={setSelectedQueue}
        onCloseQueue={() => setSelectedQueue(null)}
        selectedRun={selectedRun}
        onSelectRun={setSelectedRun}
        onCloseRun={() => setSelectedRun(null)}
      />

      {/* Run detail modal */}
      {selectedRun && (
        <RunDetailModal
          run={selectedRun}
          onClose={() => setSelectedRun(null)}
        />
      )}
    </>
  );
}
