import { useNavigate } from "react-router-dom";

interface HttpCatErrorProps {
  statusCode: number;
  title: string;
  message?: string;
  actions?: React.ReactNode;
}

const STATUS_MESSAGES: Record<number, string> = {
  401: "You need to sign in to view this page.",
  403: "You don't have permission to access this page.",
  404: "The page you're looking for doesn't exist.",
  500: "Something broke on our end.",
};

export function HttpCatError({
  statusCode,
  title,
  message,
  actions,
}: HttpCatErrorProps) {
  const navigate = useNavigate();

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bg-warm-light)]">
      <div className="w-full max-w-md rounded-3xl border border-[var(--border)] bg-white p-8 shadow-lg text-center">
        <img
          src={`https://http.cat/${statusCode}.jpg`}
          alt={`HTTP ${statusCode}`}
          className="w-full rounded-2xl mb-6"
        />
        <h1
          className="mb-2 text-2xl font-semibold text-[var(--text-main)]"
          style={{ fontFamily: "Outfit" }}
        >
          {title}
        </h1>
        <p className="mb-6 text-[var(--text-muted)]">
          {message || STATUS_MESSAGES[statusCode] || "An error occurred."}
        </p>
        {actions || (
          <button
            onClick={() => navigate("/")}
            className="rounded-full bg-[var(--brand)] px-6 py-2 font-medium text-white"
          >
            Go Home
          </button>
        )}
      </div>
    </div>
  );
}
