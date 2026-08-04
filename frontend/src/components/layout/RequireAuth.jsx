import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../shared/auth/index.js';
import { LoadingState } from '../ui/LoadingState.jsx';

export function RequireAuth({ children }) {
  const { isAuthenticated, loading } = useAuth();
  const location = useLocation();

  if (loading) return <LoadingState label="Checking session…" />;
  if (!isAuthenticated) return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  return children;
}
