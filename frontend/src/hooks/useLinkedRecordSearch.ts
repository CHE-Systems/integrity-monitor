import { useState, useEffect } from "react";
import { useAuth } from "./useAuth";
import { API_BASE } from "../config/api";

export interface LinkedRecord {
  id: string;
  name: string;
}

/**
 * Search records in a linked Airtable table by primary field value.
 * Debounces API calls by 300ms and requires at least 2 characters.
 */
export function useLinkedRecordSearch(entity: string) {
  const { getToken } = useAuth();
  const [searchTerm, setSearchTerm] = useState("");
  const [results, setResults] = useState<LinkedRecord[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!entity || searchTerm.length < 2) {
      setResults([]);
      return;
    }

    const searchRecords = async () => {
      setLoading(true);
      try {
        const token = await getToken();
        if (!token) return;
        const response = await fetch(
          `${API_BASE}/airtable/records/${encodeURIComponent(entity)}/search?q=${encodeURIComponent(searchTerm)}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (response.ok) {
          const data = await response.json();
          setResults(data.records || []);
        }
      } catch (error) {
        console.error("Failed to search linked records:", error);
      } finally {
        setLoading(false);
      }
    };

    const debounceTimer = setTimeout(searchRecords, 300);
    return () => clearTimeout(debounceTimer);
  }, [entity, searchTerm, getToken]);

  // Clear when entity changes
  useEffect(() => {
    setResults([]);
    setSearchTerm("");
  }, [entity]);

  return { searchTerm, setSearchTerm, results, loading };
}
