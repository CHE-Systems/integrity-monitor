import { useState, useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { API_BASE } from "../config/api";

export function LoginPage() {
  const {
    signInWithGoogle,
    signInWithDevToken,
    error: authError,
    loading,
    user,
  } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [error, setError] = useState<string | null>(null);

  // Redirect if already authenticated
  useEffect(() => {
    if (user) {
      const from = (location.state as { from?: string })?.from || "/";
      navigate(from, { replace: true });
    }
  }, [user, navigate, location]);

  const handleGoogleSignIn = async () => {
    setError(null);
    try {
      await signInWithGoogle();
      // Email validation will happen in AuthGuard after user state updates
      // Navigation will happen via useEffect when user state updates
    } catch (err) {
      setError(err instanceof Error ? err.message : "Google sign in failed");
    }
  };

  const handleDevSignIn = async (isManual = false) => {
    setError(null);
    try {
      const response = await fetch(
        `${API_BASE}/auth/dev-token?email=jedwards@che.school`,
        {
          method: "GET",
        }
      );

      if (!response.ok) {
        let errorMsg = "Failed to get dev token";
        try {
          const errorData = await response.json();
          errorMsg = errorData.detail || errorData.message || errorMsg;
        } catch {
          try {
            const errorText = await response.text();
            errorMsg = errorText || errorMsg;
          } catch {
            // If text parsing also fails, use default message
          }
        }
        if (isManual) {
          setError(errorMsg);
        }
        return;
      }

      const data = await response.json();
      await signInWithDevToken(data.token);
      // Navigation will happen via useEffect when user state updates
    } catch (err) {
      const errorMsg =
        err instanceof Error ? err.message : "Dev sign in failed";
      if (isManual) {
        setError(errorMsg);
      }
    }
  };

  const isLoading = loading;

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bg-warm-light)]">
      <div className="w-full max-w-md rounded-3xl border border-[var(--border)] bg-white p-8 shadow-lg">
        <h1
          className="mb-4 text-2xl font-semibold text-[var(--text-main)]"
          style={{ fontFamily: "Outfit" }}
        >
          Sign In Required
        </h1>
        <p className="mb-6 text-[var(--text-muted)]">
          Please sign in to access the Integrity Monitor dashboard.
        </p>
        <div className="space-y-4">
          {(error || authError) && (
            <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
              {error || authError}
            </div>
          )}
          <button
            onClick={handleGoogleSignIn}
            disabled={isLoading}
            className="w-full rounded-full border border-[var(--border)] px-4 py-2 font-medium text-[var(--text-main)] disabled:opacity-50"
          >
            Sign in with Google
          </button>
          {(import.meta.env.DEV ||
            import.meta.env.VITE_ENABLE_DEV_SIGNIN === "true") && (
            <>
              <div className="relative mt-4">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-[var(--border)]"></div>
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-white px-2 text-[var(--text-muted)]">
                    Dev Only
                  </span>
                </div>
              </div>
              <button
                onClick={() => handleDevSignIn(true)}
                disabled={isLoading}
                className="w-full rounded-full border-2 border-dashed border-[var(--brand)] bg-[var(--brand)]/10 px-4 py-2 font-medium text-[var(--brand)] disabled:opacity-50"
              >
                {isLoading ? "Signing in..." : "Skip Sign-In (Dev)"}
              </button>
              <p className="text-xs text-center text-[var(--text-muted)] mt-1">
                Auto-signs in as jedwards@che.school (no password required)
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
