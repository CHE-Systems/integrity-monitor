import { useMemo } from "react";
import type { AirtableRecord } from "../hooks/useAirtableRecords";
import { extractDisplayFields } from "../hooks/useAirtableRecords";
import { getAirtableLinksWithFallback } from "../utils/airtable";
import { useAirtableSchema } from "../contexts/AirtableSchemaContext";
import openInNewTabIcon from "../assets/open_in_new_tab.svg";

interface AirtableRecordCardProps {
  record: AirtableRecord;
  entity: string;
  label?: string;
  isHighlighted?: boolean;
  linkedRecordNames?: Record<string, string>;
}

/**
 * Card component displaying Airtable record data.
 * Shows key fields like name, email, phone, and creation date.
 * Linked record fields (e.g. parent link) are resolved to display names.
 */
export function AirtableRecordCard({
  record,
  entity,
  label,
  isHighlighted = false,
  linkedRecordNames,
}: AirtableRecordCardProps) {
  const { schema } = useAirtableSchema();

  const displayFields = useMemo(() => {
    return extractDisplayFields(record.fields, linkedRecordNames);
  }, [record.fields, linkedRecordNames]);

  const airtableLink = useMemo(() => {
    return getAirtableLinksWithFallback(entity, record.id, schema);
  }, [entity, record.id, schema]);

  // Format created time if available
  const createdTime = useMemo(() => {
    if (record.createdTime) {
      try {
        const date = new Date(record.createdTime);
        if (!isNaN(date.getTime())) {
          return date.toLocaleDateString("en-US", {
            year: "numeric",
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          });
        }
      } catch {
        // Fall through
      }
    }
    return null;
  }, [record.createdTime]);

  return (
    <div
      className={`rounded-xl border p-4 ${
        isHighlighted
          ? "border-2 border-[var(--brand)] bg-[var(--brand)]/5"
          : "border-[var(--border)] bg-white"
      }`}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-3 pb-2 border-b border-[var(--border)]">
        <div className="flex items-center gap-2">
          {label && (
            <span
              className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                isHighlighted
                  ? "bg-[var(--brand)]/10 text-[var(--brand)]"
                  : "bg-[var(--bg-mid)] text-[var(--text-muted)]"
              }`}
            >
              {label}
            </span>
          )}
          <span className="text-sm font-medium text-[var(--text-main)]">
            Airtable Record
          </span>
        </div>
        <a
          href={airtableLink.primary}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-[var(--cta-blue)] hover:underline inline-flex items-center gap-1"
        >
          View in Airtable
          <img
            src={openInNewTabIcon}
            alt="Open in new tab"
            className="w-3 h-3"
            style={{
              filter:
                "brightness(0) saturate(100%) invert(27%) sepia(96%) saturate(2598%) hue-rotate(210deg) brightness(97%) contrast(95%)",
            }}
          />
        </a>
      </div>

      {/* Record ID */}
      <div className="mb-3">
        <span className="text-xs text-[var(--text-muted)]">Record ID: </span>
        <span className="font-mono text-xs text-[var(--text-main)]">
          {record.id}
        </span>
      </div>

      {/* Fields */}
      {displayFields.length > 0 ? (
        <div className="space-y-2">
          {displayFields.map(({ label, value }, idx) => (
            <div key={idx} className="flex items-start gap-2">
              <span className="text-xs font-medium text-[var(--text-muted)] min-w-[80px] shrink-0">
                {label}:
              </span>
              <span className="text-sm text-[var(--text-main)] break-words">
                {value}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-[var(--text-muted)] italic">
          No displayable fields found
        </p>
      )}

      {/* Created time footer */}
      {createdTime && (
        <div className="mt-3 pt-2 border-t border-[var(--border)]">
          <span className="text-xs text-[var(--text-muted)]">
            Created: {createdTime}
          </span>
        </div>
      )}
    </div>
  );
}

interface AirtableRecordCardsProps {
  records: Record<string, AirtableRecord>;
  entity: string;
  recordIds: string[];
  currentRecordId?: string;
  linkedRecordNames?: Record<string, string>;
  loading?: boolean;
  error?: string | null;
}

/**
 * Container component for displaying one or more Airtable record cards.
 * Displays side-by-side for 2 records (duplicates), full-width for single record.
 */
export function AirtableRecordCards({
  records,
  entity,
  recordIds,
  currentRecordId,
  linkedRecordNames,
  loading = false,
  error = null,
}: AirtableRecordCardsProps) {
  const hasRecords = Object.keys(records).length > 0;
  const isDuplicate = recordIds.length === 2;

  if (loading) {
    return (
      <div className="rounded-xl border border-[var(--border)] bg-white p-6">
        <h3
          className="text-sm font-semibold text-[var(--text-main)] mb-4"
          style={{ fontFamily: "Outfit" }}
        >
          Airtable Record Data
        </h3>
        <div className="flex items-center justify-center py-8">
          <div className="inline-block animate-spin rounded-full h-6 w-6 border-b-2 border-[var(--brand)]"></div>
          <span className="ml-3 text-sm text-[var(--text-muted)]">
            Loading record data...
          </span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-[var(--border)] bg-white p-6">
        <h3
          className="text-sm font-semibold text-[var(--text-main)] mb-4"
          style={{ fontFamily: "Outfit" }}
        >
          Airtable Record Data
        </h3>
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      </div>
    );
  }

  if (!hasRecords) {
    return (
      <div className="rounded-xl border border-[var(--border)] bg-white p-6">
        <h3
          className="text-sm font-semibold text-[var(--text-main)] mb-4"
          style={{ fontFamily: "Outfit" }}
        >
          Airtable Record Data
        </h3>
        <p className="text-sm text-[var(--text-muted)]">
          No record data available
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-[var(--border)] bg-white p-6">
      <h3
        className="text-sm font-semibold text-[var(--text-main)] mb-4"
        style={{ fontFamily: "Outfit" }}
      >
        Airtable Record Data
      </h3>

      <div
        className={
          isDuplicate
            ? "grid grid-cols-1 md:grid-cols-2 gap-4"
            : "max-w-full"
        }
      >
        {recordIds.map((recordId, idx) => {
          const record = records[recordId];
          if (!record) {
            return (
              <div
                key={recordId}
                className="rounded-xl border border-[var(--border)] bg-[var(--bg-mid)]/50 p-4"
              >
                <p className="text-sm text-[var(--text-muted)]">
                  Record not found: {recordId}
                </p>
              </div>
            );
          }

          const isCurrentRecord = recordId === currentRecordId;
          const label = isDuplicate
            ? isCurrentRecord
              ? "Current Record"
              : `Duplicate #${idx + 1}`
            : undefined;

          return (
            <AirtableRecordCard
              key={recordId}
              record={record}
              entity={entity}
              label={label}
              isHighlighted={isCurrentRecord}
              linkedRecordNames={linkedRecordNames}
            />
          );
        })}
      </div>
    </div>
  );
}
