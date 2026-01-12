import { useState, useCallback } from "react";
import { useAuth } from "./useAuth";
import { API_BASE } from "../config/api";

export type Rule = {
  [key: string]: any;
  source?: "yaml" | "firestore";
};

export type RulesByCategory = {
  duplicates: Record<string, any>;
  relationships: Record<string, any>;
  required_fields: Record<string, any>;
  value_checks: Record<string, any>;
  attendance_rules: Record<string, any>;
};

export function useRules() {
  const { getToken, loading: authLoading } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadRules = useCallback(async (): Promise<RulesByCategory> => {
    // Wait for auth to be ready
    if (authLoading) {
      throw new Error("Authentication loading...");
    }

    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      if (!token) {
        throw new Error("Not authenticated. Please log in.");
      }

      const response = await fetch(`${API_BASE}/rules`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      const contentType = response.headers.get("content-type") || "";
      
      if (!response.ok || !contentType.includes("application/json")) {
        const errorText = await response.text();
        let errorMessage = `Failed to load rules: ${response.statusText}`;
        
        // Check if we received HTML instead of JSON
        if (errorText.trim().startsWith("<!") || errorText.trim().startsWith("<html")) {
          errorMessage = `Expected JSON but received HTML from ${API_BASE}/rules. This usually means:\n1. VITE_API_BASE is not set correctly in production (should point to Cloud Run backend URL)\n2. The backend is not running or not accessible\n3. Firebase Hosting is serving the SPA instead of proxying to the backend\n\nCurrent API_BASE: ${API_BASE}\nVITE_API_BASE env: ${import.meta.env.VITE_API_BASE || "not set"}\n\nTo fix: Rebuild the frontend using frontend/build-with-secrets.sh which will set VITE_API_BASE to the correct Cloud Run URL.`;
        } else {
          // Try to parse as JSON for structured error messages
          try {
            const errorData = JSON.parse(errorText);
            errorMessage = errorData.detail?.message || errorData.detail || errorMessage;
          } catch {
            errorMessage = errorText || errorMessage;
          }
        }
        throw new Error(errorMessage);
      }

      const data = await response.json();
      return data;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Failed to load rules";
      setError(errorMessage);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [getToken, authLoading]);

  const loadRulesByCategory = useCallback(
    async (category: string): Promise<any> => {
      setLoading(true);
      setError(null);
      try {
        const token = await getToken();
        if (!token) {
          throw new Error("Not authenticated. Please log in.");
        }
        const response = await fetch(`${API_BASE}/rules/${category}`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        const contentType = response.headers.get("content-type") || "";
        
        if (!response.ok || !contentType.includes("application/json")) {
          const errorText = await response.text();
          let errorMessage = `Failed to load rules: ${response.statusText}`;
          
          // Check if we received HTML instead of JSON
          if (errorText.trim().startsWith("<!") || errorText.trim().startsWith("<html")) {
            errorMessage = `Expected JSON but received HTML from ${API_BASE}/rules/${category}. This usually means:\n1. VITE_API_BASE is not set correctly in production (should point to Cloud Run backend URL)\n2. The backend is not running or not accessible\n3. Firebase Hosting is serving the SPA instead of proxying to the backend\n\nCurrent API_BASE: ${API_BASE}\nVITE_API_BASE env: ${import.meta.env.VITE_API_BASE || "not set"}\n\nTo fix: Rebuild the frontend using frontend/build-with-secrets.sh which will set VITE_API_BASE to the correct Cloud Run URL.`;
          } else {
            // Try to parse as JSON for structured error messages
            try {
              const errorData = JSON.parse(errorText);
              errorMessage = errorData.detail?.message || errorData.detail || errorMessage;
            } catch {
              errorMessage = errorText || errorMessage;
            }
          }
          throw new Error(errorMessage);
        }

        const data = await response.json();
        return data;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : "Failed to load rules";
        setError(errorMessage);
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [getToken]
  );

  const createRule = useCallback(
    async (
      category: string,
      entity: string | null,
      ruleData: Record<string, any>
    ): Promise<Rule> => {
      setLoading(true);
      setError(null);
      try {
        const token = await getToken();
        if (!token) {
          throw new Error("Not authenticated. Please log in.");
        }
        const response = await fetch(`${API_BASE}/rules/${category}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            entity,
            rule_data: ruleData,
          }),
        });

        const contentType = response.headers.get("content-type") || "";
        
        if (!response.ok || !contentType.includes("application/json")) {
          const errorText = await response.text();
          let errorMessage = `Failed to create rule: ${response.statusText}`;
          
          // Check if we received HTML instead of JSON
          if (errorText.trim().startsWith("<!") || errorText.trim().startsWith("<html")) {
            errorMessage = `Expected JSON but received HTML from ${API_BASE}/rules/${category}. This usually means:\n1. VITE_API_BASE is not set correctly in production (should point to Cloud Run backend URL)\n2. The backend is not running or not accessible\n3. Firebase Hosting is serving the SPA instead of proxying to the backend\n\nCurrent API_BASE: ${API_BASE}\nVITE_API_BASE env: ${import.meta.env.VITE_API_BASE || "not set"}\n\nTo fix: Rebuild the frontend using frontend/build-with-secrets.sh which will set VITE_API_BASE to the correct Cloud Run URL.`;
          } else {
            // Try to parse as JSON for structured error messages
            try {
              const errorData = JSON.parse(errorText);
              errorMessage = errorData.detail?.message || errorData.detail || errorMessage;
            } catch {
              errorMessage = errorText || errorMessage;
            }
          }
          throw new Error(errorMessage);
        }

        const data = await response.json();
        return data.rule;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : "Failed to create rule";
        setError(errorMessage);
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [getToken]
  );

  const updateRule = useCallback(
    async (
      category: string,
      ruleId: string,
      entity: string | null,
      ruleData: Record<string, any>
    ): Promise<Rule> => {
      setLoading(true);
      setError(null);
      try {
        const token = await getToken();
        if (!token) {
          throw new Error("Not authenticated. Please log in.");
        }
        const response = await fetch(`${API_BASE}/rules/${encodeURIComponent(category)}/${encodeURIComponent(ruleId)}`, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            entity,
            rule_data: ruleData,
          }),
        });

        const contentType = response.headers.get("content-type") || "";
        
        if (!response.ok || !contentType.includes("application/json")) {
          const errorText = await response.text();
          let errorMessage = `Failed to update rule: ${response.statusText}`;
          
          // Check if we received HTML instead of JSON
          if (errorText.trim().startsWith("<!") || errorText.trim().startsWith("<html")) {
            errorMessage = `Expected JSON but received HTML from ${API_BASE}/rules/${category}/${ruleId}. This usually means:\n1. VITE_API_BASE is not set correctly in production (should point to Cloud Run backend URL)\n2. The backend is not running or not accessible\n3. Firebase Hosting is serving the SPA instead of proxying to the backend\n\nCurrent API_BASE: ${API_BASE}\nVITE_API_BASE env: ${import.meta.env.VITE_API_BASE || "not set"}\n\nTo fix: Rebuild the frontend using frontend/build-with-secrets.sh which will set VITE_API_BASE to the correct Cloud Run URL.`;
          } else {
            // Try to parse as JSON for structured error messages
            try {
              const errorData = JSON.parse(errorText);
              errorMessage = errorData.detail?.message || errorData.detail || errorMessage;
            } catch {
              errorMessage = errorText || errorMessage;
            }
          }
          throw new Error(errorMessage);
        }

        const data = await response.json();
        return data.rule;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : "Failed to update rule";
        setError(errorMessage);
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [getToken]
  );

  const deleteRule = useCallback(
    async (category: string, ruleId: string, entity: string | null): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const token = await getToken();
        if (!token) {
          throw new Error("Not authenticated. Please log in.");
        }
        const url = new URL(`${API_BASE}/rules/${encodeURIComponent(category)}/${encodeURIComponent(ruleId)}`);
        if (entity) {
          url.searchParams.set("entity", entity);
        }

        const response = await fetch(url.toString(), {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });
        
        if (!response.ok) {
          const errorText = await response.text();
          let errorMessage = `Failed to delete rule: ${response.statusText}`;
          
          // Check if we received HTML instead of JSON
          if (errorText.trim().startsWith("<!") || errorText.trim().startsWith("<html")) {
            errorMessage = `Expected JSON but received HTML from ${url.toString()}. This usually means:\n1. VITE_API_BASE is not set correctly in production (should point to Cloud Run backend URL)\n2. The backend is not running or not accessible\n3. Firebase Hosting is serving the SPA instead of proxying to the backend\n\nCurrent API_BASE: ${API_BASE}\nVITE_API_BASE env: ${import.meta.env.VITE_API_BASE || "not set"}\n\nTo fix: Rebuild the frontend using frontend/build-with-secrets.sh which will set VITE_API_BASE to the correct Cloud Run URL.`;
          } else {
            // Try to parse as JSON for structured error messages
            try {
              const errorData = JSON.parse(errorText);
              errorMessage = errorData.detail?.message || errorData.detail || errorMessage;
            } catch {
              errorMessage = errorText || errorMessage;
            }
          }
          throw new Error(errorMessage);
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : "Failed to delete rule";
        setError(errorMessage);
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [getToken]
  );

  const parseRuleWithAI = useCallback(
    async (description: string, categoryHint?: string): Promise<any> => {
      setLoading(true);
      setError(null);
      try {
        const token = await getToken();
        if (!token) {
          throw new Error("Not authenticated. Please log in.");
        }

        const requestPayload = {
          description,
          category_hint: categoryHint,
        };

        console.log('[parseRuleWithAI] Request payload:', requestPayload);

        const response = await fetch(`${API_BASE}/rules/ai-parse`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(requestPayload),
        });

        console.log('[parseRuleWithAI] Response status:', response.status, response.statusText);

        const contentType = response.headers.get("content-type") || "";
        
        if (!response.ok || !contentType.includes("application/json")) {
          const errorText = await response.text();
          let errorMessage = `Failed to parse rule: ${response.statusText}`;
          
          // Check if we received HTML instead of JSON
          if (errorText.trim().startsWith("<!") || errorText.trim().startsWith("<html")) {
            errorMessage = `Expected JSON but received HTML from ${API_BASE}/rules/ai-parse. This usually means:\n1. VITE_API_BASE is not set correctly in production (should point to Cloud Run backend URL)\n2. The backend is not running or not accessible\n3. Firebase Hosting is serving the SPA instead of proxying to the backend\n\nCurrent API_BASE: ${API_BASE}\nVITE_API_BASE env: ${import.meta.env.VITE_API_BASE || "not set"}\n\nTo fix: Rebuild the frontend using frontend/build-with-secrets.sh which will set VITE_API_BASE to the correct Cloud Run URL.`;
          } else {
            // Try to parse as JSON for structured error messages
            try {
              const errorData = JSON.parse(errorText);
              console.error('[parseRuleWithAI] Error response:', errorData);
              errorMessage = errorData.detail?.message || errorData.detail || errorMessage;
            } catch {
              errorMessage = errorText || errorMessage;
            }
          }
          throw new Error(errorMessage);
        }

        const data = await response.json();
        console.log('[parseRuleWithAI] Success response:', data);
        return data;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : "Failed to parse rule";
        setError(errorMessage);
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [getToken]
  );

  return {
    loadRules,
    loadRulesByCategory,
    createRule,
    updateRule,
    deleteRule,
    parseRuleWithAI,
    loading,
    error,
  };
}
