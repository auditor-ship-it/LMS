import { useCallback, useEffect, useRef, useState } from 'react';
import { apiErrorMessage } from '../shared/auth/index.js';

/** Fetch-on-mount data hook shared by every page in this app. */
export function useAsync(fetcher, deps = []) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  // Dev-only React StrictMode intentionally double-invokes this effect on
  // initial mount (mount -> cleanup -> mount again) with the SAME `run`
  // reference, to surface effects that don't clean up properly. Every page
  // fetch here hits the real backend/Google Sheets quota, so that duplicate
  // is not harmless — track the last `run` this effect already fired and
  // skip firing it again for that same reference. A genuine dependency
  // change still produces a new `run` reference and still fetches normally.
  const lastRunRef = useRef(null);
  // Guards against overlapping calls to `run()` resolving OUT OF ORDER — a
  // real scenario once anything beyond "fetch once on mount" can trigger a
  // reload (a manual Refresh click, dataBus's cross-page auto-refresh, a
  // save handler's own reload()). Two in-flight requests for the same data
  // do not settle in start order; if the OLDER one happens to resolve
  // LAST, its now-stale result would overwrite the fresher one already on
  // screen with no visible error — exactly "looks stale until you click
  // Refresh again" (confirmed 2026-08-20, Renew & Document). Only the
  // most-recently-STARTED call's result is ever allowed to commit.
  const requestIdRef = useRef(0);

  /* `silent`: used by usePolling for pages whose data can change from OUTSIDE
     this app (an external Google Form submission, another user's Sheet
     edit) with no in-app write to invalidate() from. A normal reload sets
     loading=true, which flashes a full-page skeleton — fine for an explicit
     Refresh click, disruptive every 60s in the background. Silent mode
     still commits fresher data (and still respects requestIdRef, so an
     overlapping manual Refresh can't be clobbered by a slower background
     poll resolving after it), but never touches loading/error — a failed
     background poll degrades to "still showing the last good data" rather
     than replacing the screen with an error banner. */
  const run = useCallback(async (opts = {}) => {
    const { silent = false } = opts;
    const myRequestId = ++requestIdRef.current;
    if (!silent) { setLoading(true); setError(''); }
    try {
      const res = await fetcher();
      if (mounted.current && myRequestId === requestIdRef.current) setData(res);
    } catch (e) {
      if (mounted.current && myRequestId === requestIdRef.current) {
        if (!silent) setError(apiErrorMessage(e));
        else console.warn('[useAsync] silent poll failed:', e?.message || e);
      }
    } finally {
      if (mounted.current && myRequestId === requestIdRef.current && !silent) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    mounted.current = true;
    if (lastRunRef.current !== run) {
      lastRunRef.current = run;
      run();
    }
    return () => { mounted.current = false; };
  }, [run]);

  return { data, loading, error, reload: run, setData };
}
