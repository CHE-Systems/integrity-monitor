import { useState, useEffect, useRef } from "react";
import type { Issue } from "../hooks/useFirestoreIssues";
import { useIssueChat } from "../hooks/useIssueChat";
import type { ChatMessage } from "../hooks/useIssueChat";

interface IssueChatPanelProps {
  isOpen: boolean;
  onClose: () => void;
  issues: Issue[];
}

export function IssueChatPanel({ isOpen, onClose, issues }: IssueChatPanelProps) {
  const { messages, sendMessage, loading, status, error, reset } = useIssueChat(issues);
  const [input, setInput] = useState("");
  const [showConfirm, setShowConfirm] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading, status]);

  // Focus input when panel opens
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 300);
    }
  }, [isOpen]);

  // Reset conversation after confirmed close
  useEffect(() => {
    if (!isOpen) {
      reset();
      setInput("");
      setShowConfirm(false);
    }
  }, [isOpen, reset]);

  const handleClose = () => {
    // If there's conversation history, confirm before closing
    if (messages.length > 0) {
      setShowConfirm(true);
    } else {
      onClose();
    }
  };

  const handleConfirmClose = () => {
    setShowConfirm(false);
    onClose();
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!text || loading) return;
    setInput("");
    await sendMessage(text);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  if (!isOpen) return null;

  return (
    <>
      {/* Panel — no backdrop, page stays interactive */}
      <div
        className="fixed right-0 top-0 h-full w-[420px] max-w-[90vw] bg-white shadow-2xl z-50 flex flex-col animate-slide-in-right"
        style={{
          borderLeft: "1px solid var(--border)",
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-4 border-b border-[var(--border)]"
          style={{ background: "var(--bg-mid)" }}
        >
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-full bg-[var(--brand)] flex items-center justify-center">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="white"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 2L2 7l10 5 10-5-10-5z" />
                <path d="M2 17l10 5 10-5" />
                <path d="M2 12l10 5 10-5" />
              </svg>
            </div>
            <div>
              <h3
                className="text-sm font-semibold text-[var(--text-main)]"
                style={{ fontFamily: "Outfit" }}
              >
                Issue Analyst
              </h3>
              <p className="text-xs text-[var(--text-muted)]">
                {issues.length} issue{issues.length !== 1 ? "s" : ""} loaded
              </p>
            </div>
          </div>
          <button
            onClick={handleClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-[var(--border)] transition-colors text-[var(--text-muted)] hover:text-[var(--text-main)]"
            aria-label="Close chat"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
          {messages.length === 0 && !loading && (
            <div className="flex flex-col items-center justify-center h-full text-center px-6">
              <div className="w-12 h-12 rounded-full bg-[var(--bg-mid)] flex items-center justify-center mb-3">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              </div>
              <p className="text-sm font-medium text-[var(--text-main)] mb-1" style={{ fontFamily: "Outfit" }}>
                Ask about your issues
              </p>
              <p className="text-xs text-[var(--text-muted)] leading-relaxed">
                I can analyze the {issues.length} issue{issues.length !== 1 ? "s" : ""} loaded and answer questions about patterns, breakdowns, and record details.
              </p>
              <div className="mt-4 space-y-2 w-full">
                {[
                  "Summarize these issues",
                  "Which entity has the most issues?",
                  "Break down by severity",
                ].map((suggestion) => (
                  <button
                    key={suggestion}
                    onClick={() => {
                      setInput(suggestion);
                      setTimeout(() => inputRef.current?.focus(), 0);
                    }}
                    className="w-full text-left px-3 py-2 rounded-lg border border-[var(--border)] text-xs text-[var(--text-main)] hover:bg-[var(--bg-mid)] transition-colors"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg, idx) => (
            <MessageBubble key={idx} message={msg} />
          ))}

          {loading && (
            <div className="flex items-start gap-2">
              <div className="w-6 h-6 rounded-full bg-[var(--brand)] flex-shrink-0 flex items-center justify-center mt-0.5">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2L2 7l10 5 10-5-10-5z" />
                  <path d="M2 17l10 5 10-5" />
                  <path d="M2 12l10 5 10-5" />
                </svg>
              </div>
              <div className="bg-[var(--bg-mid)] rounded-2xl rounded-tl-sm px-4 py-2.5">
                <TypingIndicator />
                {status && (
                  <p className="text-[10px] text-[var(--text-muted)] mt-1 animate-status-fade">
                    {status}
                  </p>
                )}
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Error banner */}
        {error && (
          <div className="mx-4 mb-2 px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-xs text-red-600">
            {error}
          </div>
        )}

        {/* Input bar */}
        <div className="px-4 py-3 border-t border-[var(--border)] bg-white">
          <div className="flex items-center gap-2">
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask about these issues..."
              disabled={loading}
              className="flex-1 rounded-xl border border-[var(--border)] px-3.5 py-2.5 text-sm text-[var(--text-main)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--brand)]/30 focus:border-[var(--brand)] disabled:opacity-50 transition-all"
            />
            <button
              onClick={handleSend}
              disabled={loading || !input.trim()}
              className="flex-shrink-0 w-10 h-10 rounded-xl bg-[var(--brand)] text-white flex items-center justify-center hover:opacity-90 disabled:opacity-40 transition-opacity"
              aria-label="Send message"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </button>
          </div>
        </div>

        {/* Close confirmation dialog */}
        {showConfirm && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/30 rounded-l-none">
            <div className="bg-white rounded-xl shadow-lg border border-[var(--border)] mx-6 p-5 max-w-[320px]">
              <p
                className="text-sm font-semibold text-[var(--text-main)] mb-1"
                style={{ fontFamily: "Outfit" }}
              >
                Close chat?
              </p>
              <p className="text-xs text-[var(--text-muted)] mb-4 leading-relaxed">
                Your conversation history will be lost. Are you sure you want to close?
              </p>
              <div className="flex items-center gap-2 justify-end">
                <button
                  onClick={() => setShowConfirm(false)}
                  className="px-3.5 py-2 rounded-lg border border-[var(--border)] text-xs font-medium text-[var(--text-main)] hover:bg-[var(--bg-mid)] transition-colors"
                >
                  Keep open
                </button>
                <button
                  onClick={handleConfirmClose}
                  className="px-3.5 py-2 rounded-lg bg-red-500 text-white text-xs font-medium hover:bg-red-600 transition-colors"
                >
                  Close & clear
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

/**
 * Render a single chat message bubble with basic markdown formatting.
 * AI messages get a copy button.
 */
function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
      const textarea = document.createElement("textarea");
      textarea.value = message.content;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className={`group flex items-start gap-2 ${isUser ? "flex-row-reverse" : ""}`}>
      {!isUser && (
        <div className="w-6 h-6 rounded-full bg-[var(--brand)] flex-shrink-0 flex items-center justify-center mt-0.5">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2L2 7l10 5 10-5-10-5z" />
            <path d="M2 17l10 5 10-5" />
            <path d="M2 12l10 5 10-5" />
          </svg>
        </div>
      )}
      <div className="flex flex-col gap-1 max-w-[85%]">
        <div
          className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
            isUser
              ? "bg-[var(--brand)] text-white rounded-tr-sm"
              : "bg-[var(--bg-mid)] text-[var(--text-main)] rounded-tl-sm"
          }`}
        >
          {isUser ? (
            <span>{message.content}</span>
          ) : (
            <MarkdownContent content={message.content} />
          )}
        </div>
        {/* Copy button for AI responses */}
        {!isUser && (
          <button
            onClick={handleCopy}
            className={`self-start flex items-center gap-1 px-2 py-0.5 rounded text-[10px] transition-all ${
              copied
                ? "text-green-600"
                : "text-[var(--text-muted)] opacity-0 group-hover:opacity-100 hover:text-[var(--text-main)]"
            }`}
            aria-label="Copy response"
          >
            {copied ? (
              <>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                Copied
              </>
            ) : (
              <>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
                Copy
              </>
            )}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Simple markdown renderer for AI responses.
 * Handles: bold, bullet lists, numbered lists, inline code, headings, paragraphs, and tables.
 */
function MarkdownContent({ content }: { content: string }) {
  const lines = content.split("\n");
  const elements: React.ReactNode[] = [];
  let currentList: string[] = [];
  let listType: "ul" | "ol" | null = null;
  let currentTable: string[][] = [];
  let tableHasHeader = false;

  const flushList = () => {
    if (currentList.length > 0 && listType) {
      const Tag = listType;
      elements.push(
        <Tag
          key={`list-${elements.length}`}
          className={`${listType === "ul" ? "list-disc" : "list-decimal"} pl-4 space-y-0.5 my-1`}
        >
          {currentList.map((item, i) => (
            <li key={i}>
              <InlineMarkdown text={item} />
            </li>
          ))}
        </Tag>
      );
      currentList = [];
      listType = null;
    }
  };

  const flushTable = () => {
    if (currentTable.length > 0) {
      const headerRow = currentTable[0];
      const bodyRows = tableHasHeader ? currentTable.slice(1) : currentTable;
      // Show CSV download for tables with 5+ data rows
      const showCsvDownload = bodyRows.length >= 5;
      // Capture table data for the CSV closure
      const csvHeader = tableHasHeader ? [...headerRow] : null;
      const csvRows = bodyRows.map((r) => [...r]);

      elements.push(
        <div key={`table-${elements.length}`} className="my-2">
          <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
            <table className="w-full text-xs">
              {tableHasHeader && (
                <thead>
                  <tr className="bg-[var(--border)]/40">
                    {headerRow.map((cell, ci) => (
                      <th
                        key={ci}
                        className="px-2.5 py-1.5 text-left font-semibold text-[var(--text-main)] border-b border-[var(--border)]"
                      >
                        <InlineMarkdown text={cell.trim()} />
                      </th>
                    ))}
                  </tr>
                </thead>
              )}
              <tbody>
                {bodyRows.map((row, ri) => (
                  <tr
                    key={ri}
                    className={ri % 2 === 0 ? "" : "bg-[var(--bg-mid)]/50"}
                  >
                    {row.map((cell, ci) => (
                      <td
                        key={ci}
                        className="px-2.5 py-1.5 text-[var(--text-main)] border-b border-[var(--border)]/50"
                      >
                        <InlineMarkdown text={cell.trim()} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {showCsvDownload && (
            <CsvDownloadButton header={csvHeader} rows={csvRows} />
          )}
        </div>
      );
      currentTable = [];
      tableHasHeader = false;
    }
  };

  /** Check if a line is a markdown table separator (e.g., |---|---|) */
  const isTableSeparator = (line: string) =>
    /^\|[\s\-:]+(\|[\s\-:]+)+\|?\s*$/.test(line);

  /** Parse a table row into cells */
  const parseTableRow = (line: string): string[] => {
    const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
    return trimmed.split("|").map((c) => c.trim());
  };

  /** Check if a line looks like a table row */
  const isTableRow = (line: string) =>
    /^\|.*\|/.test(line.trim());

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // --- Table rows ---
    if (isTableRow(line)) {
      // If we're not already in a table, flush other pending elements
      if (currentTable.length === 0) {
        flushList();
      }

      // Skip separator rows but mark that we have a header
      if (isTableSeparator(line)) {
        if (currentTable.length === 1) {
          tableHasHeader = true;
        }
        continue;
      }

      currentTable.push(parseTableRow(line));
      continue;
    }

    // If we were in a table and hit a non-table line, flush the table
    if (currentTable.length > 0) {
      flushTable();
    }

    // Bullet list item
    const bulletMatch = line.match(/^[\s]*[-*]\s+(.*)/);
    if (bulletMatch) {
      if (listType !== "ul") flushList();
      listType = "ul";
      currentList.push(bulletMatch[1]);
      continue;
    }

    // Numbered list item
    const numMatch = line.match(/^[\s]*\d+[.)]\s+(.*)/);
    if (numMatch) {
      if (listType !== "ol") flushList();
      listType = "ol";
      currentList.push(numMatch[1]);
      continue;
    }

    // Non-list line — flush any pending list
    flushList();

    // Empty line
    if (line.trim() === "") {
      elements.push(<div key={`br-${i}`} className="h-2" />);
      continue;
    }

    // Heading (### or ##)
    const headingMatch = line.match(/^#{1,3}\s+(.*)/);
    if (headingMatch) {
      elements.push(
        <p key={`h-${i}`} className="font-semibold mt-1">
          <InlineMarkdown text={headingMatch[1]} />
        </p>
      );
      continue;
    }

    // Normal paragraph
    elements.push(
      <p key={`p-${i}`}>
        <InlineMarkdown text={line} />
      </p>
    );
  }

  flushList();
  flushTable();

  return <div className="space-y-0.5">{elements}</div>;
}

/**
 * Download button that exports a rendered table as CSV.
 */
function CsvDownloadButton({
  header,
  rows,
}: {
  header: string[] | null;
  rows: string[][];
}) {
  const handleDownload = () => {
    const escapeCsv = (cell: string) => {
      // Strip markdown bold/italic markers for clean CSV
      const clean = cell.replace(/\*\*/g, "").replace(/\*/g, "").trim();
      if (clean.includes(",") || clean.includes('"') || clean.includes("\n")) {
        return `"${clean.replace(/"/g, '""')}"`;
      }
      return clean;
    };

    const csvLines: string[] = [];
    if (header) {
      csvLines.push(header.map(escapeCsv).join(","));
    }
    for (const row of rows) {
      csvLines.push(row.map(escapeCsv).join(","));
    }

    const blob = new Blob([csvLines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `issue-analyst-table-${Date.now()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <button
      onClick={handleDownload}
      className="mt-1.5 flex items-center gap-1 px-2 py-1 rounded text-[10px] text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--bg-mid)] transition-colors"
      title="Download this table as CSV"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
      Download table as CSV ({rows.length} rows)
    </button>
  );
}

/**
 * Render inline markdown: **bold**, `code`, *italic*.
 */
function InlineMarkdown({ text }: { text: string }) {
  // Split on bold (**text**), code (`text`), and italic (*text*)
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g);

  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("**") && part.endsWith("**")) {
          return (
            <strong key={i} className="font-semibold">
              {part.slice(2, -2)}
            </strong>
          );
        }
        if (part.startsWith("`") && part.endsWith("`")) {
          return (
            <code
              key={i}
              className="bg-[var(--border)]/50 px-1 py-0.5 rounded text-xs font-mono"
            >
              {part.slice(1, -1)}
            </code>
          );
        }
        if (part.startsWith("*") && part.endsWith("*") && !part.startsWith("**")) {
          return (
            <em key={i}>{part.slice(1, -1)}</em>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

/**
 * Animated typing indicator (three bouncing dots).
 */
function TypingIndicator() {
  return (
    <div className="flex items-center gap-1 py-0.5">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="w-1.5 h-1.5 rounded-full bg-[var(--text-muted)]"
          style={{
            animation: "chat-bounce 1.4s ease-in-out infinite",
            animationDelay: `${i * 0.2}s`,
          }}
        />
      ))}
      <style>{`
        @keyframes chat-bounce {
          0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
          30% { transform: translateY(-4px); opacity: 1; }
        }
        @keyframes slide-in-right {
          from { transform: translateX(100%); }
          to { transform: translateX(0); }
        }
        .animate-slide-in-right {
          animation: slide-in-right 0.25s ease-out;
        }
        @keyframes status-fade {
          from { opacity: 0; transform: translateY(2px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .animate-status-fade {
          animation: status-fade 0.3s ease-out;
        }
      `}</style>
    </div>
  );
}
