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
import { HttpCatError } from "./components/HttpCatError";
import { ApiKeysPage } from "./pages/ApiKeysPage";
import { CategoryQueuePage } from "./pages/CategoryQueuePage";
import { RemediationPage } from "./pages/RemediationPage";
import { MergeHistoryPage } from "./pages/MergeHistoryPage";
import { UsersPage } from "./pages/UsersPage";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/"
            element={
              <AuthGuard requireAdmin={false}>
                <App>
                  <LeadershipDashboardPage />
                </App>
              </AuthGuard>
            }
          />
          <Route
            path="/admin"
            element={
              <AuthGuard requireAdmin={true}>
                <App>
                  <AdminDashboardPage />
                </App>
              </AuthGuard>
            }
          />
          <Route
            path="/runs"
            element={
              <AuthGuard requireAdmin={true}>
                <App>
                  <RunsPage />
                </App>
              </AuthGuard>
            }
          />
          <Route
            path="/schema"
            element={
              <AuthGuard requireAdmin={true}>
                <App>
                  <SchemaPage />
                </App>
              </AuthGuard>
            }
          />
          <Route
            path="/run/:runId"
            element={
              <AuthGuard requireAdmin={true}>
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
              <AuthGuard requireAdmin={false}>
                <App>
                  <IssuesPage />
                </App>
              </AuthGuard>
            }
          />
          <Route
            path="/issue/:issueId"
            element={
              <AuthGuard requireAdmin={false}>
                <App>
                  <IssueDetailPage />
                </App>
              </AuthGuard>
            }
          />
          <Route
            path="/scheduling"
            element={
              <AuthGuard requireAdmin={true}>
                <App>
                  <SchedulingPage />
                </App>
              </AuthGuard>
            }
          />
          <Route
            path="/rules"
            element={
              <AuthGuard requireAdmin={true}>
                <App>
                  <RulesPage />
                </App>
              </AuthGuard>
            }
          />
          <Route
            path="/rules/:category/:entity?/:ruleId"
            element={
              <AuthGuard requireAdmin={true}>
                <App>
                  <RuleDetailPage />
                </App>
              </AuthGuard>
            }
          />
          <Route
            path="/issues/queue"
            element={
              <AuthGuard requireAdmin={false}>
                <App>
                  <CategoryQueuePage />
                </App>
              </AuthGuard>
            }
          />
          <Route
            path="/issues/fix"
            element={
              <AuthGuard requireAdmin={false}>
                <App>
                  <RemediationPage />
                </App>
              </AuthGuard>
            }
          />
          <Route
            path="/issues/history"
            element={
              <AuthGuard requireAdmin={false}>
                <App>
                  <MergeHistoryPage />
                </App>
              </AuthGuard>
            }
          />
          <Route
            path="/remediate"
            element={<Navigate to="/issues" replace />}
          />
          <Route
            path="/api-keys"
            element={
              <AuthGuard requireAdmin={true}>
                <App>
                  <ApiKeysPage />
                </App>
              </AuthGuard>
            }
          />
          <Route
            path="/users"
            element={
              <AuthGuard requireAdmin={true}>
                <App>
                  <UsersPage />
                </App>
              </AuthGuard>
            }
          />
          <Route path="*" element={<HttpCatError statusCode={404} title="Page Not Found" />} />
        </Routes>
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>
);
