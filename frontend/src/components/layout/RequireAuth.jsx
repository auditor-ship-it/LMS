import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../shared/auth/index.js';
import { LoadingState } from '../ui/LoadingState.jsx';

export function RequireAuth({ children }) {
  const { isAuthenticated, loading } = useAuth();
  const location = useLocation();

  if (loading) return <LoadingState label="Checking session…" />;
  // pathname + search — a bare pathname drops query params (e.g. a Refunds
  // approval email's ?rowNum=&stage=), landing the user on the plain page
  // after login instead of back on the exact entry they clicked through to.
  if (!isAuthenticated) return <Navigate to="/login" state={{ from: location.pathname + location.search }} replace />;
  return children;
}
