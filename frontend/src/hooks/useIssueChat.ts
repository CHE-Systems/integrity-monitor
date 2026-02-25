import { useState, useCallback, useRef, useMemo, useEffect } from "react";
import { auth } from "../config/firebase";
import { API_BASE } from "../config/api";
import type { Issue } from "./useFirestoreIssues";
import { buildIssueSummary, buildRecordIdsByEntity } from "../utils/issueSummary";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** Rotating status messages shown while the AI is processing. */
const STATUS_STEPS = [
  { text: "Analyzing your question…", delay: 0 },
  { text: "Searching issue data…", delay: 2000 },
  { text: "Loading records from Airtable…", delay: 5500 },
  { text: "Crunching the numbers…", delay: 9000 },
  { text: "Generating response…", delay: 13000 },
];

interface UseIssueChatResult {
  messages: ChatMessage[];
  sendMessage: (text: string) => Promise<void>;
  loading: boolean;
  status: string;
  error: string | null;
  reset: () => void;
}

/**
 * Hook for managing AI chat about issues.
 * Sends issue summary + conversation to the backend, which proxies to OpenAI.
 */
export function useIssueChat(issues: Issue[]): UseIssueChatResult {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Pre-compute the context once when issues change (stable refs)
  const issueContext = useMemo(() => buildIssueSummary(issues), [issues]);
  const recordIdsByEntity = useMemo(() => buildRecordIdsByEntity(issues), [issues]);

  // Use a ref for the abort controller so we can cancel in-flight requests
  const abortRef = useRef<AbortController | null>(null);
  const statusTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Clear status timers on unmount or when loading finishes
  const clearStatusTimers = useCallback(() => {
    statusTimersRef.current.forEach(clearTimeout);
    statusTimersRef.current = [];
  }, []);

  // Progress through status messages while loading
  useEffect(() => {
    if (loading) {
      clearStatusTimers();
      setStatus(STATUS_STEPS[0].text);

      for (let i = 1; i < STATUS_STEPS.length; i++) {
        const timer = setTimeout(() => {
          setStatus(STATUS_STEPS[i].text);
        }, STATUS_STEPS[i].delay);
        statusTimersRef.current.push(timer);
      }
    } else {
      clearStatusTimers();
      setStatus("");
    }

    return clearStatusTimers;
  }, [loading, clearStatusTimers]);

  const sendMessage = useCallback(
    async (text: string) => {
      if (!text.trim() || loading) return;

      const userMessage: ChatMessage = { role: "user", content: text.trim() };

      setMessages((prev) => [...prev, userMessage]);
      setLoading(true);
      setError(null);

      // Cancel any in-flight request
      if (abortRef.current) {
        abortRef.current.abort();
      }
      abortRef.current = new AbortController();

      try {
        const user = auth.currentUser;
        if (!user) {
          throw new Error("Not authenticated");
        }

        const token = await user.getIdToken();

        // Build the messages array for the API (all conversation history)
        const apiMessages = [...messages, userMessage].map((m) => ({
          role: m.role,
          content: m.content,
        }));

        const response = await fetch(`${API_BASE}/chat/issues`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            messages: apiMessages,
            issue_context: issueContext,
            record_ids_by_entity: recordIdsByEntity,
          }),
          signal: abortRef.current.signal,
        });

        if (!response.ok) {
          const errorData = await response
            .json()
            .catch(() => ({ detail: "Request failed" }));
          throw new Error(
            typeof errorData.detail === "string"
              ? errorData.detail
              : errorData.detail?.message || "Chat request failed"
          );
        }

        const data = await response.json();
        const assistantMessage: ChatMessage = {
          role: "assistant",
          content: data.response || "No response received.",
        };

        setMessages((prev) => [...prev, assistantMessage]);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          // Request was cancelled, don't set error
          return;
        }
        const message =
          err instanceof Error ? err.message : "Failed to send message";
        setError(message);
        // Add error as an assistant message so user sees it in the chat
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: `Sorry, something went wrong: ${message}`,
          },
        ]);
      } finally {
        setLoading(false);
      }
    },
    [messages, loading, issueContext, recordIdsByEntity]
  );

  const reset = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
    clearStatusTimers();
    setMessages([]);
    setError(null);
    setLoading(false);
    setStatus("");
  }, [clearStatusTimers]);

  return { messages, sendMessage, loading, status, error, reset };
}
