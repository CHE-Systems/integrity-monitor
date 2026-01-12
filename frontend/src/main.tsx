import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import "./index.css";
import App from "./App.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { AuthGuard } from "./components/AuthGuard";
import { LoginPage } from "./pages/LoginPage";
import { LeadershipDashboardPage } from "./pages/LeadershipDashboardPage";
import { AdminDashboardPage } from "./pages/AdminDashboardPage";
import { SchemaPage } from "./pages/SchemaPage";
import { RunStatusPage } from "./pages/RunStatusPage";
import { ReportsPage } from "./pages/ReportsPage";
import { RunsPage } from "./pages/RunsPage";
import { IssueDetailPage } from "./pages/IssueDetailPage";
import { IssuesPage } from "./pages/IssuesPage";
import { SchedulingPage } from "./pages/SchedulingPage";
import { RulesPage } from "./pages/RulesPage";
import { RuleDetailPage } from "./pages/RuleDetailPage";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/"
            element={
              <AuthGuard>
                <App>
                  <LeadershipDashboardPage />
                </App>
              </AuthGuard>
            }
          />
          <Route
            path="/admin"
            element={
              <AuthGuard>
                <App>
                  <AdminDashboardPage />
                </App>
              </AuthGuard>
            }
          />
          <Route
            path="/runs"
            element={
              <AuthGuard>
                <App>
                  <RunsPage />
                </App>
              </AuthGuard>
            }
          />
          <Route
            path="/schema"
            element={
              <AuthGuard>
                <App>
                  <SchemaPage />
                </App>
              </AuthGuard>
            }
          />
          <Route
            path="/run/:runId"
            element={
              <AuthGuard>
                <App>
                  <RunStatusPage />
                </App>
              </AuthGuard>
            }
          />
          {/* Reports route disabled - uncomment to re-enable
          <Route
            path="/reports"
            element={
              <AuthGuard>
                <App>
                  <ReportsPage />
                </App>
              </AuthGuard>
            }
          />
          */}
          <Route
            path="/issues"
            element={
              <AuthGuard>
                <App>
                  <IssuesPage />
                </App>
              </AuthGuard>
            }
          />
          <Route
            path="/issue/:issueId"
            element={
              <AuthGuard>
                <App>
                  <IssueDetailPage />
                </App>
              </AuthGuard>
            }
          />
          <Route
            path="/scheduling"
            element={
              <AuthGuard>
                <App>
                  <SchedulingPage />
                </App>
              </AuthGuard>
            }
          />
          <Route
            path="/rules"
            element={
              <AuthGuard>
                <App>
                  <RulesPage />
                </App>
              </AuthGuard>
            }
          />
          <Route
            path="/rules/:category/:entity?/:ruleId"
            element={
              <AuthGuard>
                <App>
                  <RuleDetailPage />
                </App>
              </AuthGuard>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>
);
