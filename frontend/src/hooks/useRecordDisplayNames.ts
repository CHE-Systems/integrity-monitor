import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { auth } from "../config/firebase";
import { API_BASE } from "../config/api";
import { useAirtableSchema } from "../contexts/AirtableSchemaContext";

/**
 * Hook that resolves primary field display names for a list of issues
 * across multiple entities. Groups record IDs by entity, fetches Airtable
 * records in batches, and extracts the primary field value for each.
 *
 * Returns a map of recordId -> displayName.
 */
export function useRecordDisplayNames(
  issues: Array<{ record_id: string; entity: string }>
): Record<string, string> {
  const { schema } = useAirtableSchema();
  const [names, setNames] = useState<Record<string, string>>({});
  const fetchedRef = useRef<Set<string>>(new Set());

  // Group record IDs by entity for the current page of issues
  const entityGroups = useMemo(() => {
    const groups: Record<string, string[]> = {};
    for (const issue of issues) {
      if (!issue.entity || !issue.record_id) continue;
      // Skip if we already have this record's name
      if (fetchedRef.current.has(issue.record_id)) continue;
      if (!groups[issue.entity]) groups[issue.entity] = [];
      if (!groups[issue.entity].includes(issue.record_id)) {
        groups[issue.entity].push(issue.record_id);
      }
    }
    return groups;
  }, [issues]);

  // Resolve primary field name for a given entity from the schema
  const getPrimaryFieldName = useCallback(
    (entity: string): string | null => {
      if (!schema?.tables) return null;
      const normalized = entity.toLowerCase().replace(/ /g, "_");
      for (const table of schema.tables) {
        const tableName = table.name?.toLowerCase().replace(/ /g, "_");
        if (
          tableName === normalized ||
          normalized.includes(tableName) ||
          tableName?.includes(normalized)
        ) {
          const primaryId = table.primaryFieldId;
          if (primaryId) {
            const field = table.fields?.find((f: any) => f.id === primaryId);
            if (field) return field.name;
          }
          break;
        }
      }
      return null;
    },
    [schema]
  );

  // Extract display name from a record using the primary field
  const extractName = useCallback(
    (rec: any, primaryFieldName: string): string | null => {
      if (!rec?.fields) return null;
      const val = rec.fields[primaryFieldName];
      if (val == null || val === "") return null;
      if (typeof val === "string") return val;
      if (Array.isArray(val)) return val.length > 0 ? String(val[0]) : null;
      return String(val);
    },
    []
  );

  useEffect(() => {
    const entities = Object.keys(entityGroups);
    if (entities.length === 0) return;

    let cancelled = false;

    const fetchAll = async () => {
      const user = auth.currentUser;
      if (!user) return;

      const token = await user.getIdToken();
      const newNames: Record<string, string> = {};

      await Promise.all(
        entities.map(async (entity) => {
          const recordIds = entityGroups[entity];
          if (recordIds.length === 0) return;

          const primaryFieldName = getPrimaryFieldName(entity);
          if (!primaryFieldName) return;

          try {
            const response = await fetch(`${API_BASE}/airtable/records/by-ids`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ entity, record_ids: recordIds }),
            });

            if (!response.ok) return;
            const data = await response.json();
            if (!data.records) return;

            for (const [id, rec] of Object.entries(data.records)) {
              const name = extractName(rec, primaryFieldName);
              if (name) {
                newNames[id] = name;
                fetchedRef.current.add(id);
              }
            }
          } catch {
            // Silently fail — names are non-critical
          }
        })
      );

      if (!cancelled && Object.keys(newNames).length > 0) {
        setNames((prev) => ({ ...prev, ...newNames }));
      }
    };

    fetchAll();
    return () => {
      cancelled = true;
    };
  }, [entityGroups, getPrimaryFieldName, extractName]);

  return names;
}
