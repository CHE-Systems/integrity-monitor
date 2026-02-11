import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";

interface AuthGuardProps {
  children: ReactNode;
  requireAdmin?: boolean;
}

export function AuthGuard({ children, requireAdmin = true }: AuthGuardProps) {
  const { user, isAdmin, loading, signOut } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-center">
          <p className="text-lg text-[var(--text-muted)]">Loading...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }

  // Check if user has @che.school email for basic access
  const userEmail = user.email || user.providerData?.[0]?.email || "";
  const hasCheSchoolEmail = userEmail.endsWith("@che.school");

  // For non-admin routes, require @che.school email
  if (!requireAdmin && !hasCheSchoolEmail) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--bg-warm-light)]">
        <div className="w-full max-w-md rounded-3xl border border-[var(--border)] bg-white p-8 shadow-lg">
          <h1
            className="mb-4 text-2xl font-semibold text-[var(--text-main)]"
            style={{ fontFamily: "Outfit" }}
          >
            Access Denied
          </h1>
          <p className="mb-6 text-[var(--text-muted)]">
            This application is only available to users with @che.school email addresses.
          </p>
          <div className="space-y-3">
            <button
              onClick={async () => {
                try {
                  await signOut();
                } catch (error) {
                  console.error("Sign out failed:", error);
                }
              }}
              className="w-full rounded-full bg-[var(--brand)] px-4 py-2 font-medium text-white"
            >
              Sign Out
            </button>
          </div>
        </div>
      </div>
    );
  }

  // If admin is required, check admin status
  if (requireAdmin && !isAdmin) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--bg-warm-light)]">
        <div className="w-full max-w-md rounded-3xl border border-[var(--border)] bg-white p-8 shadow-lg">
          <h1
            className="mb-4 text-2xl font-semibold text-[var(--text-main)]"
            style={{ fontFamily: "Outfit" }}
          >
            Access Denied
          </h1>
          <p className="mb-6 text-[var(--text-muted)]">
            You need administrator privileges to access this page.
          </p>

          {/* Debug Information */}
          <div className="mb-6 rounded-lg bg-gray-50 border border-gray-200 p-4 text-sm">
            <p className="font-semibold text-gray-700 mb-2">Debug Info:</p>
            <p className="text-gray-600">
              <span className="font-medium">Email:</span> {user?.email || "N/A"}
            </p>
            <p className="text-gray-600 break-all">
              <span className="font-medium">UID:</span> {user?.uid || "N/A"}
            </p>
            <p className="text-gray-600">
              <span className="font-medium">Admin Status:</span>{" "}
              {isAdmin ? "true" : "false"}
            </p>
            <p className="text-xs text-gray-500 mt-2">
              To grant admin access, add this UID to Firestore:
              <br />
              Collection: users / Document: {user?.uid} / Field: isAdmin = true
            </p>
          </div>

          <div className="space-y-3">
            <button
              onClick={async () => {
                try {
                  await signOut();
                } catch (error) {
                  console.error("Sign out failed:", error);
                }
              }}
              className="w-full rounded-full bg-[var(--brand)] px-4 py-2 font-medium text-white"
            >
              Sign Out
            </button>
            <button
              onClick={() => window.location.reload()}
              className="w-full rounded-full border border-[var(--border)] px-4 py-2 font-medium text-[var(--text-main)]"
            >
              Refresh
            </button>
          </div>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
