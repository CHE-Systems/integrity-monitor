import React, { useState } from "react";

interface BulkDeleteModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (filters: {
    issueTypes: string[];
    entities: string[];
    dateRange: "past_hour" | "past_day" | "past_week" | "custom" | "all";
    customStartDate?: string;
    customEndDate?: string;
  }) => void;
}

const ISSUE_TYPES = [
  { value: "duplicate", label: "Duplicate" },
  { value: "missing_link", label: "Missing Link" },
  { value: "missing_field", label: "Missing Field" },
  { value: "attendance", label: "Attendance" },
];

const ENTITIES = [
  { value: "contractors", label: "Contractors" },
];

export const BulkDeleteModal: React.FC<BulkDeleteModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
}) => {
  const [selectedIssueTypes, setSelectedIssueTypes] = useState<string[]>([]);
  const [selectedEntities, setSelectedEntities] = useState<string[]>([]);
  const [dateRange, setDateRange] = useState<
    "past_hour" | "past_day" | "past_week" | "custom" | "all"
  >("all");
  const [customStartDate, setCustomStartDate] = useState("");
  const [customEndDate, setCustomEndDate] = useState("");

  if (!isOpen) return null;

  const handleIssueTypeToggle = (type: string) => {
    setSelectedIssueTypes((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type]
    );
  };

  const handleEntityToggle = (entity: string) => {
    setSelectedEntities((prev) =>
      prev.includes(entity)
        ? prev.filter((e) => e !== entity)
        : [...prev, entity]
    );
  };

  const handleSubmit = () => {
    // Validation: if dateRange is "all" and no type/entity filters, allow it (delete everything)
    // Otherwise, must select at least one type or entity
    if (
      dateRange !== "all" &&
      selectedIssueTypes.length === 0 &&
      selectedEntities.length === 0
    ) {
      alert(
        "Please select at least one issue type or entity to delete, or select 'All Issues' for date range."
      );
      return;
    }

    if (dateRange === "custom" && (!customStartDate || !customEndDate)) {
      alert("Please provide both start and end dates for custom date range.");
      return;
    }

    onConfirm({
      issueTypes: selectedIssueTypes,
      entities: selectedEntities,
      dateRange,
      customStartDate: dateRange === "custom" ? customStartDate : undefined,
      customEndDate: dateRange === "custom" ? customEndDate : undefined,
    });
  };

  const handleReset = () => {
    setSelectedIssueTypes([]);
    setSelectedEntities([]);
    setDateRange("all");
    setCustomStartDate("");
    setCustomEndDate("");
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-0">
      <div
        className="fixed inset-0 bg-neutral-900/50 backdrop-blur-sm transition-opacity"
        onClick={onClose}
        aria-hidden="true"
      />

      <div className="relative bg-white border border-[var(--border)] rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto transform transition-all p-6">
        <h3 className="text-lg font-semibold text-[var(--text-main)] mb-4">
          Bulk Delete Issues
        </h3>

        {/* Issue Types */}
        <div className="mb-6">
          <label className="block text-sm font-medium text-[var(--text-main)] mb-2">
            Issue Types (select any combination)
          </label>
          <div className="grid grid-cols-2 gap-2">
            {ISSUE_TYPES.map((type) => (
              <label
                key={type.value}
                className="flex items-center space-x-2 cursor-pointer p-2 rounded-lg hover:bg-[var(--bg-mid)]/30"
              >
                <input
                  type="checkbox"
                  checked={selectedIssueTypes.includes(type.value)}
                  onChange={() => handleIssueTypeToggle(type.value)}
                  className="w-4 h-4 text-[var(--cta-blue)] border-[var(--border)] rounded focus:ring-[var(--cta-blue)]"
                />
                <span className="text-sm text-[var(--text-main)]">
                  {type.label}
                </span>
              </label>
            ))}
          </div>
        </div>

        {/* Entities */}
        <div className="mb-6">
          <label className="block text-sm font-medium text-[var(--text-main)] mb-2">
            Entities (select any combination)
          </label>
          <div className="grid grid-cols-2 gap-2">
            {ENTITIES.map((entity) => (
              <label
                key={entity.value}
                className="flex items-center space-x-2 cursor-pointer p-2 rounded-lg hover:bg-[var(--bg-mid)]/30"
              >
                <input
                  type="checkbox"
                  checked={selectedEntities.includes(entity.value)}
                  onChange={() => handleEntityToggle(entity.value)}
                  className="w-4 h-4 text-[var(--cta-blue)] border-[var(--border)] rounded focus:ring-[var(--cta-blue)]"
                />
                <span className="text-sm text-[var(--text-main)]">
                  {entity.label}
                </span>
              </label>
            ))}
          </div>
        </div>

        {/* Date Range */}
        <div className="mb-6">
          <label className="block text-sm font-medium text-[var(--text-main)] mb-2">
            Date Range
          </label>
          <div className="space-y-2">
            <label className="flex items-center space-x-2 cursor-pointer p-2 rounded-lg hover:bg-[var(--bg-mid)]/30">
              <input
                type="radio"
                name="dateRange"
                value="all"
                checked={dateRange === "all"}
                onChange={() => setDateRange("all")}
                className="w-4 h-4 text-[var(--cta-blue)] border-[var(--border)] focus:ring-[var(--cta-blue)]"
              />
              <span className="text-sm text-[var(--text-main)]">
                All Issues
              </span>
            </label>
            <label className="flex items-center space-x-2 cursor-pointer p-2 rounded-lg hover:bg-[var(--bg-mid)]/30">
              <input
                type="radio"
                name="dateRange"
                value="past_hour"
                checked={dateRange === "past_hour"}
                onChange={() => setDateRange("past_hour")}
                className="w-4 h-4 text-[var(--cta-blue)] border-[var(--border)] focus:ring-[var(--cta-blue)]"
              />
              <span className="text-sm text-[var(--text-main)]">Past Hour</span>
            </label>
            <label className="flex items-center space-x-2 cursor-pointer p-2 rounded-lg hover:bg-[var(--bg-mid)]/30">
              <input
                type="radio"
                name="dateRange"
                value="past_day"
                checked={dateRange === "past_day"}
                onChange={() => setDateRange("past_day")}
                className="w-4 h-4 text-[var(--cta-blue)] border-[var(--border)] focus:ring-[var(--cta-blue)]"
              />
              <span className="text-sm text-[var(--text-main)]">Past Day</span>
            </label>
            <label className="flex items-center space-x-2 cursor-pointer p-2 rounded-lg hover:bg-[var(--bg-mid)]/30">
              <input
                type="radio"
                name="dateRange"
                value="past_week"
                checked={dateRange === "past_week"}
                onChange={() => setDateRange("past_week")}
                className="w-4 h-4 text-[var(--cta-blue)] border-[var(--border)] focus:ring-[var(--cta-blue)]"
              />
              <span className="text-sm text-[var(--text-main)]">Past Week</span>
            </label>
            <label className="flex items-center space-x-2 cursor-pointer p-2 rounded-lg hover:bg-[var(--bg-mid)]/30">
              <input
                type="radio"
                name="dateRange"
                value="custom"
                checked={dateRange === "custom"}
                onChange={() => setDateRange("custom")}
                className="w-4 h-4 text-[var(--cta-blue)] border-[var(--border)] focus:ring-[var(--cta-blue)]"
              />
              <span className="text-sm text-[var(--text-main)]">
                Custom Date Range
              </span>
            </label>
            {dateRange === "custom" && (
              <div className="ml-6 space-y-2">
                <div>
                  <label className="block text-xs text-[var(--text-muted)] mb-1">
                    Start Date
                  </label>
                  <input
                    type="datetime-local"
                    value={customStartDate}
                    onChange={(e) => setCustomStartDate(e.target.value)}
                    className="w-full rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-[var(--text-main)]"
                  />
                </div>
                <div>
                  <label className="block text-xs text-[var(--text-muted)] mb-1">
                    End Date
                  </label>
                  <input
                    type="datetime-local"
                    value={customEndDate}
                    onChange={(e) => setCustomEndDate(e.target.value)}
                    className="w-full rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-[var(--text-main)]"
                  />
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex justify-end space-x-3 pt-4 border-t border-[var(--border)]">
          <button
            onClick={handleReset}
            className="px-4 py-2 text-sm font-medium text-[var(--text-muted)] hover:text-[var(--text-main)] bg-[var(--bg-mid)]/50 hover:bg-[var(--bg-mid)] rounded-lg transition-colors"
          >
            Reset
          </button>
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-[var(--text-muted)] hover:text-[var(--text-main)] bg-[var(--bg-mid)]/50 hover:bg-[var(--bg-mid)] rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            className="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors shadow-sm shadow-red-500/20"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
};
