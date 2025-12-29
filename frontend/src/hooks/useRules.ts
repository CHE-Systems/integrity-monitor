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

      if (!response.ok) {
        const errorText = await response.text();
        let errorMessage = `Failed to load rules: ${response.statusText}`;
        try {
          const errorData = JSON.parse(errorText);
          errorMessage = errorData.detail?.message || errorData.detail || errorMessage;
        } catch {
          errorMessage = errorText || errorMessage;
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

        if (!response.ok) {
          throw new Error(`Failed to load rules: ${response.statusText}`);
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

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(
            errorData.detail?.message || errorData.detail || `Failed to create rule: ${response.statusText}`
          );
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

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(
            errorData.detail?.message || errorData.detail || `Failed to update rule: ${response.statusText}`
          );
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
          const errorData = await response.json().catch(() => ({}));
          throw new Error(
            errorData.detail?.message || errorData.detail || `Failed to delete rule: ${response.statusText}`
          );
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

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          console.error('[parseRuleWithAI] Error response:', errorData);
          throw new Error(
            errorData.detail?.message || errorData.detail || `Failed to parse rule: ${response.statusText}`
          );
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
