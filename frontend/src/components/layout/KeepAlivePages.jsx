import { Suspense, useRef } from 'react';
import { useLocation, matchPath } from 'react-router-dom';
import { LoadingState } from '../ui/LoadingState.jsx';
import { APP_ROUTES } from '../../routes/routes.jsx';

/**
 * Renders every page the user has visited this session and keeps them all
 * mounted, toggling visibility with `hidden` instead of letting react-router
 * unmount/remount on navigation. That means each page's useAsync() data fetch
 * only ever runs once per session (first visit), not on every sidebar click —
 * switching back to a page shows its last-loaded state instantly instead of
 * re-hitting the backend/Google Sheets and re-showing a loading spinner.
 */
export function KeepAlivePages() {
  const location = useLocation();
  const visitedPaths = useRef([]);

  const current = APP_ROUTES.find((r) => matchPath({ path: r.path, end: true }, location.pathname));
  if (current && !visitedPaths.current.includes(current.path)) {
    visitedPaths.current = [...visitedPaths.current, current.path];
  }

  return (
    <>
      {visitedPaths.current.map((path) => {
        const route = APP_ROUTES.find((r) => r.path === path);
        if (!route) return null;
        const Element = route.element;
        const isActive = path === current?.path;
        return (
          <div key={path} hidden={!isActive}>
            <Suspense fallback={<LoadingState label="Loading page…" />}>
              <Element isActive={isActive} />
            </Suspense>
          </div>
        );
      })}
    </>
  );
}
