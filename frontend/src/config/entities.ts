/**
 * Central configuration for active entities and their table mappings.
 * This is the single source of truth for which entities are enabled in the system.
 * 
 * To add or remove entities, update this file and ensure backend files are aligned:
 * - backend/fetchers/registry.py (ENTITY_KEYS)
 * - backend/config/table_mapping.yaml (entity_table_mapping)
 */

/**
 * List of active entity names that are enabled in the system.
 * These entities will appear in scan configuration, scheduling, and rules pages.
 */
export const ACTIVE_ENTITIES = [
  "absent",
  "contractors",
  "parents",
  "students",
] as const;

/**
 * Mapping from entity names to Airtable table names.
 * This matches the backend table_mapping.yaml configuration.
 */
export const ENTITY_TABLE_MAPPING: Record<string, string> = {
  students: "Students",
  parents: "Parents",
  contractors: "Contractors/Volunteers",
  absent: "Absent",
};

/**
 * Reverse mapping: table name to entity name.
 * Used to map Airtable table names back to entity identifiers.
 */
export const TABLE_ENTITY_MAPPING: Record<string, string> = Object.fromEntries(
  Object.entries(ENTITY_TABLE_MAPPING).map(([entity, table]) => [table, entity])
);

/**
 * Type for active entity names (for TypeScript type safety)
 */
export type ActiveEntity = typeof ACTIVE_ENTITIES[number];

