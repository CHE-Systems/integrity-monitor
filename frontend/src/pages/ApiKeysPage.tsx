import { useState, useEffect } from "react";
import { useAuth } from "../hooks/useAuth";
import { useApiKeys } from "../hooks/useApiKeys";
import type { ApiKey, CreatedApiKey } from "../hooks/useApiKeys";

export function ApiKeysPage() {
  const { user } = useAuth();
  const { listKeys, createKey, deleteKey, loading, error } = useApiKeys();
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [newKeyName, setNewKeyName] = useState("");
  const [createdKey, setCreatedKey] = useState<CreatedApiKey | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pageLoading, setPageLoading] = useState(true);

  useEffect(() => {
    if (user) loadKeys();
  }, [user]);

  const loadKeys = async () => {
    try {
      setPageLoading(true);
      const result = await listKeys();
      setKeys(result);
    } catch {
      // error set in hook
    } finally {
      setPageLoading(false);
    }
  };

  const handleCreate = async () => {
    if (!newKeyName.trim()) return;
    try {
      const result = await createKey(newKeyName.trim());
      setCreatedKey(result);
      setNewKeyName("");
      setShowCreateForm(false);
      await loadKeys();
    } catch {
      // error set in hook
    }
  };

  const handleDelete = async (keyId: string) => {
    try {
      await deleteKey(keyId);
      setDeleteConfirmId(null);
      await loadKeys();
    } catch {
      // error set in hook
    }
  };

  const handleCopy = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return "Never";
    try {
      return new Date(dateStr).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    } catch {
      return dateStr;
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1
          className="text-3xl font-semibold text-[var(--text-main)]"
          style={{ fontFamily: "Outfit" }}
        >
          API Keys
        </h1>
        <p className="mt-1 text-[var(--text-muted)]">
          Create personal API keys for programmatic access to bearer-token
          endpoints. Keys are scoped to your account.
        </p>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {error}
        </div>
      )}

      {/* Created Key Banner */}
      {createdKey && (
        <div className="rounded-xl border-2 border-amber-400 bg-amber-50 p-5">
          <div className="flex items-start justify-between">
            <div>
              <h3 className="font-semibold text-amber-900">
                API Key Created: {createdKey.name}
              </h3>
              <p className="mt-1 text-sm text-amber-800">
                Copy this key now. You won't be able to see it again.
              </p>
            </div>
            <button
              onClick={() => setCreatedKey(null)}
              className="text-amber-600 hover:text-amber-800"
            >
              Dismiss
            </button>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <code className="flex-1 rounded-lg border border-amber-300 bg-white px-4 py-2 font-mono text-sm text-[var(--text-main)] select-all break-all">
              {createdKey.key}
            </code>
            <button
              onClick={() => handleCopy(createdKey.key)}
              className="shrink-0 rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      )}

      {/* Create Form */}
      {showCreateForm ? (
        <div className="rounded-2xl border border-[var(--border)] bg-white p-5">
          <h3 className="mb-3 font-semibold text-[var(--text-main)]">
            Create New API Key
          </h3>
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <label className="mb-1 block text-sm font-medium text-[var(--text-main)]">
                Key Name
              </label>
              <input
                type="text"
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                placeholder="e.g., My Analysis Script"
                maxLength={100}
                className="w-full rounded-lg border border-[var(--border)] p-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--cta-blue)]"
                autoFocus
              />
            </div>
            <button
              onClick={handleCreate}
              disabled={loading || !newKeyName.trim()}
              className="rounded-lg bg-[var(--brand)] px-5 py-2.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {loading ? "Creating..." : "Create"}
            </button>
            <button
              onClick={() => {
                setShowCreateForm(false);
                setNewKeyName("");
              }}
              className="rounded-lg border border-[var(--border)] px-5 py-2.5 text-sm font-medium text-[var(--text-main)] hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setShowCreateForm(true)}
          className="rounded-lg bg-[var(--brand)] px-5 py-2.5 text-sm font-medium text-white hover:opacity-90"
        >
          Create API Key
        </button>
      )}

      {/* Keys Table */}
      <div className="rounded-2xl border border-[var(--border)] bg-white overflow-hidden">
        {pageLoading ? (
          <div className="p-8 text-center text-[var(--text-muted)]">
            Loading...
          </div>
        ) : keys.length === 0 ? (
          <div className="p-8 text-center text-[var(--text-muted)]">
            No API keys yet. Create one to get started.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] bg-gray-50/50">
                <th className="px-5 py-3 text-left font-medium text-[var(--text-muted)]">
                  Name
                </th>
                <th className="px-5 py-3 text-left font-medium text-[var(--text-muted)]">
                  Key
                </th>
                <th className="px-5 py-3 text-left font-medium text-[var(--text-muted)]">
                  Created
                </th>
                <th className="px-5 py-3 text-left font-medium text-[var(--text-muted)]">
                  Last Used
                </th>
                <th className="px-5 py-3 text-right font-medium text-[var(--text-muted)]">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr
                  key={key.id}
                  className="border-b border-[var(--border)] last:border-0"
                >
                  <td className="px-5 py-3 font-medium text-[var(--text-main)]">
                    {key.name}
                  </td>
                  <td className="px-5 py-3">
                    <code className="rounded bg-gray-100 px-2 py-1 font-mono text-xs text-[var(--text-muted)]">
                      {key.key_prefix}
                    </code>
                  </td>
                  <td className="px-5 py-3 text-[var(--text-muted)]">
                    {formatDate(key.created_at)}
                  </td>
                  <td className="px-5 py-3 text-[var(--text-muted)]">
                    {formatDate(key.last_used_at)}
                  </td>
                  <td className="px-5 py-3 text-right">
                    {deleteConfirmId === key.id ? (
                      <div className="flex items-center justify-end gap-2">
                        <span className="text-xs text-[var(--text-muted)]">
                          Delete?
                        </span>
                        <button
                          onClick={() => handleDelete(key.id)}
                          disabled={loading}
                          className="rounded-lg bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                        >
                          Confirm
                        </button>
                        <button
                          onClick={() => setDeleteConfirmId(null)}
                          className="rounded-lg border border-[var(--border)] px-3 py-1 text-xs font-medium text-[var(--text-main)] hover:bg-gray-50"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setDeleteConfirmId(key.id)}
                        className="rounded-lg px-3 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
                      >
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
