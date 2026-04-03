import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../hooks/useAuth";
import {
  useAdminUsers,
  type AppUser,
} from "../hooks/useAdminUsers";
import { API_BASE } from "../config/api";

export function UsersPage() {
  const { user } = useAuth();
  const {
    listUsers,
    createUser,
    updateUser,
    deleteUser,
    error,
    clearError,
    listSource,
  } = useAdminUsers();

  const apiOfflineList = listSource === "firestore";

  const [users, setUsers] = useState<AppUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [newEmail, setNewEmail] = useState("");
  const [newIsAdmin, setNewIsAdmin] = useState(false);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      clearError();
      const list = await listUsers();
      setUsers(list);
    } catch {
      // error surfaced via hook
    } finally {
      setLoading(false);
    }
  }, [listUsers, clearError]);

  useEffect(() => {
    if (user) void load();
  }, [user, load]);

  const handleToggleAdmin = async (row: AppUser) => {
    try {
      setSavingId(row.id);
      clearError();
      await updateUser(row.id, { isAdmin: !row.isAdmin });
      await load();
    } catch {
      // hook sets error
    } finally {
      setSavingId(null);
    }
  };

  const handleDelete = async (uid: string) => {
    try {
      setSavingId(uid);
      clearError();
      await deleteUser(uid);
      setDeleteId(null);
      await load();
    } catch {
      // hook sets error
    } finally {
      setSavingId(null);
    }
  };

  const handleCreate = async () => {
    const email = newEmail.trim();
    if (!email) return;
    try {
      setCreating(true);
      clearError();
      await createUser(email, newIsAdmin);
      setNewEmail("");
      setNewIsAdmin(false);
      await load();
    } catch {
      // hook sets error
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1
          className="text-3xl font-semibold text-[var(--text-main)]"
          style={{ fontFamily: "Outfit" }}
        >
          Users
        </h1>
        <p className="mt-1 text-[var(--text-muted)]">
          Manage Firestore user profiles and admin access. Adding a user creates
          or links a Firebase Auth account by email and writes{" "}
          <code className="text-sm rounded bg-[var(--bg-mid)] px-1 py-0.5">
            users/&lt;uid&gt;
          </code>
          . Deleting removes that document and the Auth user.
        </p>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {error}
        </div>
      )}

      {apiOfflineList && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
          <p className="font-medium">API unreachable — showing users from Firestore</p>
          <p className="mt-1 text-amber-900/90">
            Could not reach <code className="rounded bg-amber-100/80 px-1">{API_BASE}</code>{" "}
            (start the backend for full CRUD). Listing uses your browser session; add, change
            admin, and delete still require the server.
          </p>
        </div>
      )}

      <div className="rounded-2xl border border-[var(--border)] bg-white/90 p-6 shadow-sm">
        <h2
          className="text-lg font-semibold text-[var(--text-main)]"
          style={{ fontFamily: "Outfit" }}
        >
          Add user
        </h2>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          If the email is new to Firebase Auth, an account is created (no
          password set; use Google sign-in or a password reset if enabled).
        </p>
        {apiOfflineList && (
          <p className="mt-2 text-sm text-amber-800">
            Unavailable while the API is offline.
          </p>
        )}
        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="flex-1 block">
            <span className="text-xs font-medium text-[var(--text-muted)]">
              Email
            </span>
            <input
              type="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              placeholder="name@che.school"
              disabled={apiOfflineList}
              className="mt-1 w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--text-main)] disabled:opacity-50"
            />
          </label>
          <label className="flex items-center gap-2 text-sm text-[var(--text-main)]">
            <input
              type="checkbox"
              checked={newIsAdmin}
              onChange={(e) => setNewIsAdmin(e.target.checked)}
              disabled={apiOfflineList}
              className="rounded border-[var(--border)] disabled:opacity-50"
            />
            Admin
          </label>
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={apiOfflineList || creating || !newEmail.trim()}
            className="rounded-full bg-[var(--brand)] px-5 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {creating ? "Adding…" : "Add user"}
          </button>
        </div>
      </div>

      <div className="rounded-2xl border border-[var(--border)] bg-white/90 overflow-hidden shadow-sm">
        <div className="border-b border-[var(--border)] px-6 py-4">
          <h2
            className="text-lg font-semibold text-[var(--text-main)]"
            style={{ fontFamily: "Outfit" }}
          >
            All users
          </h2>
        </div>
        {loading ? (
          <p className="p-6 text-sm text-[var(--text-muted)]">Loading…</p>
        ) : users.length === 0 ? (
          <p className="p-6 text-sm text-[var(--text-muted)]">
            No user documents yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-[var(--border)] bg-[var(--bg-warm-light)]">
                <tr>
                  <th className="px-6 py-3 font-medium text-[var(--text-muted)]">
                    Email
                  </th>
                  <th className="px-6 py-3 font-medium text-[var(--text-muted)]">
                    UID
                  </th>
                  <th className="px-6 py-3 font-medium text-[var(--text-muted)]">
                    Admin
                  </th>
                  <th className="px-6 py-3 font-medium text-[var(--text-muted)] text-right">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {users.map((row) => {
                  const isSelf = user?.uid === row.id;
                  const busy = savingId === row.id;
                  const mutationsDisabled = apiOfflineList || busy;
                  return (
                    <tr
                      key={row.id}
                      className="border-b border-[var(--border)] last:border-0"
                    >
                      <td className="px-6 py-3 text-[var(--text-main)]">
                        {row.email || "—"}
                      </td>
                      <td className="px-6 py-3 font-mono text-xs text-[var(--text-muted)] break-all max-w-[200px]">
                        {row.id}
                      </td>
                      <td className="px-6 py-3">
                        <button
                          type="button"
                          disabled={mutationsDisabled}
                          onClick={() => void handleToggleAdmin(row)}
                          className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                            row.isAdmin
                              ? "bg-[var(--brand)] text-white"
                              : "border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-main)]"
                          } disabled:opacity-50`}
                          title={
                            apiOfflineList
                              ? "Requires API server"
                              : undefined
                          }
                        >
                          {busy
                            ? "…"
                            : row.isAdmin
                            ? "Admin"
                            : "Not admin"}
                        </button>
                      </td>
                      <td className="px-6 py-3 text-right">
                        {isSelf ? (
                          <span className="text-xs text-[var(--text-muted)]">
                            You
                          </span>
                        ) : deleteId === row.id ? (
                          <span className="inline-flex flex-wrap items-center justify-end gap-2">
                            <button
                              type="button"
                              disabled={mutationsDisabled}
                              onClick={() => void handleDelete(row.id)}
                              className="rounded-full bg-red-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
                            >
                              Confirm delete
                            </button>
                            <button
                              type="button"
                              disabled={mutationsDisabled}
                              onClick={() => setDeleteId(null)}
                              className="rounded-full border border-[var(--border)] px-3 py-1 text-xs font-medium text-[var(--text-main)]"
                            >
                              Cancel
                            </button>
                          </span>
                        ) : (
                          <button
                            type="button"
                            disabled={mutationsDisabled}
                            onClick={() => setDeleteId(row.id)}
                            className="text-xs font-medium text-red-600 hover:text-red-800 disabled:opacity-50"
                          >
                            Delete
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
