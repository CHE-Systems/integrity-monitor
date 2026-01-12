import { useEffect, useMemo, useState } from "react";
import { AirtableSchemaView } from "../components/AirtableSchemaView";
import { deriveSummaryFromSchema } from "../utils/airtable";
import type { AirtableSchema, AirtableSummary } from "../utils/airtable";
import { useAuth } from "../hooks/useAuth";

import { API_BASE } from "../config/api";

async function fetchJson<T>(path: string, token?: string): Promise<T> {
  const url = `${API_BASE}${path}`;
  const headers: HeadersInit = {};
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const response = await fetch(url, { cache: "no-store", headers });
  const contentType = response.headers.get("content-type") || "";
  if (!response.ok) {
    if (response.status === 401) {
      throw new Error(
        `Unauthorized (401) for ${url}. Sign in and retry, or rely on /airtable-schema.json fallback.`
      );
    }
    const message = await response.text();
    throw new Error(message || `Request failed (${response.status}) for ${url}`);
  }
  if (!contentType.includes("application/json")) {
    const message = await response.text();
    const errorMessage =
      message && message.trim().startsWith("<")
        ? `Expected JSON but received HTML from ${url}. This usually means:\n1. VITE_API_BASE is not set correctly in production (should point to Cloud Run backend URL)\n2. The backend is not running or not accessible\n3. Firebase Hosting is serving the SPA instead of proxying to the backend\n\nCurrent API_BASE: ${API_BASE}\nVITE_API_BASE env: ${
            import.meta.env.VITE_API_BASE || "not set"
          }\n\nTo fix: Rebuild the frontend using frontend/build-with-secrets.sh which will set VITE_API_BASE to the correct Cloud Run URL.`
        : message || `Request failed (${response.status}) for ${url}`;
    throw new Error(errorMessage);
  }
  return (await response.json()) as T;
}

async function fetchLocalSchema(): Promise<AirtableSchema> {
  const response = await fetch("/airtable-schema.json", { cache: "no-store" });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || "Local airtable-schema.json not found.");
  }
  return (await response.json()) as AirtableSchema;
}

export function SchemaPage() {
  const [schema, setSchema] = useState<AirtableSchema | null>(null);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [schemaLoading, setSchemaLoading] = useState(true);
  const [summary, setSummary] = useState<AirtableSummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const { getToken, user, loading: authLoading } = useAuth();

  const onToast = () => {
    // no-op: Schema view supports toasts, but App.tsx owns global toasts
  };

  useEffect(() => {
    // Don't load data until auth is ready
    if (authLoading) return;

    const loadSummary = async () => {
      try {
        const data = await fetchJson<AirtableSummary>(
          "/airtable/schema/summary"
        );
        setSummary(data);
      } catch (error) {
        setSummaryError(error instanceof Error ? error.message : String(error));
        // If schema is already present, derive a local summary as a fallback.
        if (schema) {
          setSummary(deriveSummaryFromSchema(schema));
        }
      } finally {
        setSummaryLoading(false);
      }
    };

    const loadSchema = async () => {
      try {
        // Prefer backend schema when authenticated; otherwise fall back to local static schema.
        const token = user ? await getToken() : null;
        if (token) {
          const data = await fetchJson<AirtableSchema>("/airtable/schema", token);
          setSchema(data);
          if (!summary && !summaryLoading) {
            setSummary(deriveSummaryFromSchema(data));
          }
          return;
        }

        // Not authenticated: load from local file.
        const localData = await fetchLocalSchema();
        setSchema(localData);
        if (!summary) {
          setSummary(deriveSummaryFromSchema(localData));
        }
      } catch (error) {
        // Fallback to local file
        try {
          const localData = await fetchLocalSchema();
          setSchema(localData);
          // Also derive summary locally
          if (!summary) {
            setSummary(deriveSummaryFromSchema(localData));
          }
        } catch {
          setSchemaError(
            error instanceof Error ? error.message : String(error)
          );
        }
      } finally {
        setSchemaLoading(false);
      }
    };

    loadSummary();
    loadSchema();
  }, [authLoading, user, getToken]);

  // Derive summary from schema if not available
  const derivedSummary = useMemo(() => {
    if (summary) return summary;
    if (schema) return deriveSummaryFromSchema(schema);
    return null;
  }, [summary, schema]);

  const schemaTotals = useMemo(() => {
    if (schema) {
      return {
        tables: schema.tables.length,
        fields: schema.tables.reduce((sum, t) => sum + (t.fieldCount || 0), 0),
        records: schema.tables.reduce((sum, t) => sum + (t.recordCount || 0), 0),
      };
    }
    if (derivedSummary) {
      return {
        tables: derivedSummary.tableCount,
        fields: derivedSummary.fieldCount,
        records: derivedSummary.recordCount,
      };
    }
    return { tables: 0, fields: 0, records: 0 };
  }, [schema, derivedSummary]);

  return (
    <AirtableSchemaView
      schema={schema}
      schemaError={schemaError}
      schemaLoading={schemaLoading}
      schemaTotals={schemaTotals}
      summary={derivedSummary}
      summaryError={summaryError}
      summaryLoading={summaryLoading}
      onToast={onToast}
    />
  );
}
