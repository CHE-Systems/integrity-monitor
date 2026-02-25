import { Component } from "react";
import type { ReactNode, ErrorInfo } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("ErrorBoundary caught an error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="flex min-h-screen items-center justify-center bg-[var(--bg-warm-light)]">
          <div className="w-full max-w-md rounded-3xl border border-[var(--border)] bg-white p-8 shadow-lg text-center">
            <img
              src="https://http.cat/500.jpg"
              alt="HTTP 500"
              className="w-full rounded-2xl mb-6"
            />
            <h1
              className="mb-2 text-2xl font-semibold text-[var(--text-main)]"
              style={{ fontFamily: "Outfit" }}
            >
              Something went wrong
            </h1>
            <p className="mb-6 text-[var(--text-muted)]">
              {this.state.error?.message || "An unexpected error occurred"}
            </p>
            <button
              onClick={() => window.location.reload()}
              className="rounded-full bg-[var(--brand)] px-6 py-2 font-medium text-white"
            >
              Reload Page
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
