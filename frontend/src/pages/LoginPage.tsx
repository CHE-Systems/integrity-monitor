import { useState, useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";

export function LoginPage() {
  const {
    signIn,
    signInWithGoogle,
    signInWithDevToken,
    signOut,
    error: authError,
    loading,
    user,
  } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isAutoAttempt, setIsAutoAttempt] = useState(false);

  // Redirect if already authenticated
  useEffect(() => {
    if (user) {
      const from = (location.state as { from?: string })?.from || "/";
      navigate(from, { replace: true });
    }
  }, [user, navigate, location]);

  const handleEmailSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    
    // Validate @che.school email
    if (!email.endsWith("@che.school")) {
      setError("This application is only available to users with @che.school email addresses.");
      return;
    }
    
    try {
      await signIn(email, password);
      // Navigation will happen via useEffect when user state updates
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed");
    }
  };

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
    if (!isManual) {
      setIsAutoAttempt(true);
    } else {
      setIsAutoAttempt(false);
    }
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
          <form onSubmit={handleEmailSignIn} className="space-y-4">
            <div>
              <label
                htmlFor="email"
                className="block text-sm font-medium text-[var(--text-main)] mb-1"
              >
                Email
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="w-full rounded-lg border border-[var(--border)] px-3 py-2 text-[var(--text-main)]"
                placeholder="your@email.com"
              />
            </div>
            <div>
              <label
                htmlFor="password"
                className="block text-sm font-medium text-[var(--text-main)] mb-1"
              >
                Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="w-full rounded-lg border border-[var(--border)] px-3 py-2 text-[var(--text-main)]"
                placeholder="••••••••"
              />
            </div>
            {(error || authError) && (
              <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
                {error || authError}
              </div>
            )}
            <button
              type="submit"
              disabled={isLoading}
              className="w-full rounded-full bg-[var(--brand)] px-4 py-2 font-medium text-white disabled:opacity-50"
            >
              {isLoading ? "Signing in..." : "Sign In"}
            </button>
          </form>
          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-[var(--border)]"></div>
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-white px-2 text-[var(--text-muted)]">Or</span>
            </div>
          </div>
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
