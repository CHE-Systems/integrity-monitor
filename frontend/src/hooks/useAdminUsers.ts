import { useCallback, useState } from "react";
import { collection, getDocs } from "firebase/firestore";
import { useAuth } from "./useAuth";
import { API_BASE } from "../config/api";
import { db } from "../config/firebase";

export type AppUser = {
  id: string;
  email: string | null;
  isAdmin: boolean;
  createdAt?: string;
  updatedAt?: string;
  created_at?: string;
  updated_at?: string;
};

async function readErrorMessage(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const j = JSON.parse(text) as { detail?: unknown };
    if (typeof j.detail === "string") return j.detail;
    if (j.detail && typeof j.detail === "object" && j.detail !== null) {
      const d = j.detail as { message?: string; error?: string };
      if (d.message) return d.message;
      if (d.error) return d.error;
    }
  } catch {
    // not JSON
  }
  return text || res.statusText;
}

function isApiUnreachable(err: unknown): boolean {
  if (err instanceof TypeError && err.message === "Failed to fetch") return true;
  if (err instanceof Error && /failed to fetch|networkerror|load failed/i.test(err.message))
    return true;
  return false;
}

async function listUsersFromFirestore(): Promise<AppUser[]> {
  const snap = await getDocs(collection(db, "users"));
  const users: AppUser[] = snap.docs.map((docSnap) => {
    const d = docSnap.data();
    return {
      id: docSnap.id,
      email: typeof d.email === "string" ? d.email : null,
      isAdmin: Boolean(d.isAdmin),
    };
  });
  users.sort((a, b) =>
    (a.email || "").localeCompare(b.email || "", undefined, {
      sensitivity: "base",
    })
  );
  return users;
}

export type UsersListSource = "api" | "firestore" | null;

export function useAdminUsers() {
  const { getToken } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [listSource, setListSource] = useState<UsersListSource>(null);

  const authHeaders = useCallback(async () => {
    const token = await getToken();
    if (!token) throw new Error("Not signed in");
    return {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
  }, [getToken]);

  const listUsers = useCallback(async (): Promise<AppUser[]> => {
    setError(null);
    try {
      const headers = await authHeaders();
      const res = await fetch(`${API_BASE}/admin/users`, { headers });
      if (!res.ok) {
        const msg = await readErrorMessage(res);
        setError(msg);
        setListSource(null);
        throw new Error(msg);
      }
      const data = (await res.json()) as { users?: AppUser[] };
      setListSource("api");
      return data.users ?? [];
    } catch (err) {
      if (isApiUnreachable(err)) {
        try {
          const fromFs = await listUsersFromFirestore();
          setListSource("firestore");
          setError(null);
          return fromFs;
        } catch (fsErr) {
          const msg =
            fsErr instanceof Error ? fsErr.message : "Firestore read failed";
          setError(msg);
          setListSource(null);
          throw fsErr;
        }
      }
      const msg = err instanceof Error ? err.message : "Failed to load users";
      setError(msg);
      setListSource(null);
      throw err;
    }
  }, [authHeaders]);

  const createUser = useCallback(
    async (email: string, isAdmin: boolean): Promise<AppUser> => {
      setError(null);
      const headers = await authHeaders();
      const res = await fetch(`${API_BASE}/admin/users`, {
        method: "POST",
        headers,
        body: JSON.stringify({ email, isAdmin }),
      });
      if (!res.ok) {
        const msg = await readErrorMessage(res);
        setError(msg);
        throw new Error(msg);
      }
      const data = (await res.json()) as { user: AppUser };
      return data.user;
    },
    [authHeaders]
  );

  const updateUser = useCallback(
    async (
      uid: string,
      patch: { isAdmin?: boolean; email?: string }
    ): Promise<AppUser> => {
      setError(null);
      const headers = await authHeaders();
      const res = await fetch(
        `${API_BASE}/admin/users/${encodeURIComponent(uid)}`,
        {
          method: "PATCH",
          headers,
          body: JSON.stringify(patch),
        }
      );
      if (!res.ok) {
        const msg = await readErrorMessage(res);
        setError(msg);
        throw new Error(msg);
      }
      const data = (await res.json()) as { user: AppUser };
      return data.user;
    },
    [authHeaders]
  );

  const deleteUser = useCallback(
    async (uid: string): Promise<void> => {
      setError(null);
      const headers = await authHeaders();
      const res = await fetch(
        `${API_BASE}/admin/users/${encodeURIComponent(uid)}`,
        {
          method: "DELETE",
          headers,
        }
      );
      if (!res.ok) {
        const msg = await readErrorMessage(res);
        setError(msg);
        throw new Error(msg);
      }
    },
    [authHeaders]
  );

  const clearError = useCallback(() => setError(null), []);

  return {
    listUsers,
    createUser,
    updateUser,
    deleteUser,
    error,
    clearError,
    listSource,
  };
}
