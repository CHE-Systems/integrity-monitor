import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { type AirtableSchema } from "../utils/airtable";
import { useAuth } from "../hooks/useAuth";
import { API_BASE } from "../config/api";

interface AirtableSchemaContextType {
  schema: AirtableSchema | null;
  loading: boolean;
  error: string | null;
}

const AirtableSchemaContext = createContext<
  AirtableSchemaContextType | undefined
>(undefined);

export function AirtableSchemaProvider({ children }: { children: ReactNode }) {
  const [schema, setSchema] = useState<AirtableSchema | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const { getToken, user } = useAuth();

  useEffect(() => {
    let mounted = true;

    const fetchSchema = async () => {
      // Don't fetch if no user
      if (!user) {
        if (mounted) setLoading(false);
        return;
      }

      try {
        const token = await getToken();
        if (!token) {
          throw new Error("Authentication required");
        }

        const response = await fetch(`${API_BASE}/airtable/schema`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (!response.ok) {
          throw new Error(`Failed to fetch schema: ${response.statusText}`);
        }

        const data = await response.json();
        if (mounted) {
          setSchema(data);
          setError(null);
        }
      } catch (err) {
        if (mounted) {
          // Try to load local schema as fallback
          try {
            console.warn(
              "Fetching remote schema failed, trying local fallback",
              err
            );
            const localResponse = await fetch("/airtable-schema.json");
            if (localResponse.ok) {
              const contentType =
                localResponse.headers.get("content-type") || "";
              if (!contentType.includes("application/json")) {
                throw new Error(
                  `Expected JSON but received ${contentType}. The file /airtable-schema.json may not exist in production.`
                );
              }
              const localData = await localResponse.json();
              setSchema(localData);
              setError(null); // Clear error if fallback succeeds
            } else {
              setError(
                err instanceof Error ? err.message : "Failed to load schema"
              );
            }
          } catch (fallbackErr) {
            setError(
              err instanceof Error ? err.message : "Failed to load schema"
            );
          }
        }
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    };

    fetchSchema();

    return () => {
      mounted = false;
    };
  }, [user, getToken]);

  return (
    <AirtableSchemaContext.Provider value={{ schema, loading, error }}>
      {children}
    </AirtableSchemaContext.Provider>
  );
}

export function useAirtableSchema() {
  const context = useContext(AirtableSchemaContext);
  if (context === undefined) {
    throw new Error(
      "useAirtableSchema must be used within an AirtableSchemaProvider"
    );
  }
  return context;
}
