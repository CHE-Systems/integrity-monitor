import { useState, useEffect } from "react";
import { useAuth } from "./useAuth";
import { API_BASE } from "../config/api";

export interface FieldOption {
  id: string;
  name: string;
  type?: string;
}

/**
 * Reusable hook for searching Airtable schema fields by entity.
 * Debounces API calls by 300ms and requires at least 2 characters.
 */
export function useFieldSearch(entity: string) {
  const { getToken } = useAuth();
  const [searchTerm, setSearchTerm] = useState("");
  const [fieldOptions, setFieldOptions] = useState<FieldOption[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!entity || !searchTerm || searchTerm.length < 2) {
      setFieldOptions([]);
      return;
    }

    const lookupFields = async () => {
      setLoading(true);
      try {
        const token = await getToken();
        if (!token) return;
        const response = await fetch(
          `${API_BASE}/airtable/schema/fields/${entity}?search=${encodeURIComponent(searchTerm)}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (response.ok) {
          const data = await response.json();
          setFieldOptions(data.fields || []);
        }
      } catch (error) {
        console.error("Failed to lookup fields:", error);
      } finally {
        setLoading(false);
      }
    };

    const debounceTimer = setTimeout(lookupFields, 300);
    return () => clearTimeout(debounceTimer);
  }, [entity, searchTerm, getToken]);

  // Clear options when entity changes
  useEffect(() => {
    setFieldOptions([]);
    setSearchTerm("");
  }, [entity]);

  return { searchTerm, setSearchTerm, fieldOptions, loading };
}
