import { useState, useCallback } from "react";
import { useAuth } from "./useAuth";
import { API_BASE } from "../config/api";

export interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  created_at: string | null;
  last_used_at: string | null;
}

export interface CreatedApiKey {
  id: string;
  name: string;
  key: string;
  key_prefix: string;
}

export function useApiKeys() {
  const { getToken } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const listKeys = useCallback(async (): Promise<ApiKey[]> => {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      if (!token) throw new Error("Not authenticated");

      const response = await fetch(`${API_BASE}/api-keys`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `Failed to list API keys (${response.status})`);
      }

      const data = await response.json();
      return data.keys;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to list API keys";
      setError(msg);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  const createKey = useCallback(
    async (name: string): Promise<CreatedApiKey> => {
      setLoading(true);
      setError(null);
      try {
        const token = await getToken();
        if (!token) throw new Error("Not authenticated");

        const response = await fetch(`${API_BASE}/api-keys`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ name }),
        });

        if (!response.ok) {
          const text = await response.text();
          throw new Error(
            text || `Failed to create API key (${response.status})`
          );
        }

        return await response.json();
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : "Failed to create API key";
        setError(msg);
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [getToken]
  );

  const deleteKey = useCallback(
    async (keyId: string): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const token = await getToken();
        if (!token) throw new Error("Not authenticated");

        const response = await fetch(`${API_BASE}/api-keys/${keyId}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        });

        if (!response.ok) {
          const text = await response.text();
          throw new Error(
            text || `Failed to delete API key (${response.status})`
          );
        }
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : "Failed to delete API key";
        setError(msg);
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [getToken]
  );

  return { listKeys, createKey, deleteKey, loading, error };
}
