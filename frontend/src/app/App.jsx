import { Routes, Route, Navigate } from 'react-router-dom';
import { RequireAuth } from '../components/layout/RequireAuth.jsx';
import { AppShell } from '../components/layout/AppShell.jsx';
import { ErrorBoundary } from '../components/layout/ErrorBoundary.jsx';
import { LoginPage } from '../pages/auth/LoginPage.jsx';
import { IconSprite } from '../components/ui/IconSprite.jsx';
import { ROUTES } from '../constants/routes.js';

/**
 * Sub-paths under "/" aren't rendered via nested <Route element>s — AppShell's
 * KeepAlivePages picks the page to show from the URL itself and keeps every
 * visited one mounted. The "*" route below just tells react-router that any
 * sub-path is valid so it doesn't fall through the top-level <Routes>.
 */
export default function App() {
  return (
    <ErrorBoundary>
      <IconSprite />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/"
          element={(
            <RequireAuth>
              <AppShell />
            </RequireAuth>
          )}
        >
          <Route index element={<Navigate to={ROUTES.MY_TASK} replace />} />
          <Route path="*" element={null} />
        </Route>
      </Routes>
    </ErrorBoundary>
  );
}
