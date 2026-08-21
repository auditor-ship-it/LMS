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

  const run = useCallback(async () => {
    const myRequestId = ++requestIdRef.current;
    const t0 = performance.now();
    // TEMP DIAGNOSTIC (2026-08-21) — pinning down a reported "instant backend,
    // stale UI" case. Remove once resolved.
    // eslint-disable-next-line no-console
    console.log(`[useAsync] #${myRequestId} START`);
    setLoading(true);
    setError('');
    try {
      const res = await fetcher();
      const willCommit = mounted.current && myRequestId === requestIdRef.current;
      // Compact summary, not the full payload — easy to eyeball across
      // several overlapping log lines instead of expanding a huge object.
      const renewedCount = Array.isArray(res?.data) ? res.data.filter((r) => r.actionStatus).length : null;
      // eslint-disable-next-line no-console
      console.log(`[useAsync] #${myRequestId} RESOLVED after ${(performance.now() - t0).toFixed(0)}ms | current=${requestIdRef.current} | commit=${willCommit} | rows=${res?.data?.length ?? '?'} | withActionStatus=${renewedCount}`);
      if (willCommit) setData(res);
    } catch (e) {
      if (mounted.current && myRequestId === requestIdRef.current) setError(apiErrorMessage(e));
    } finally {
      if (mounted.current && myRequestId === requestIdRef.current) setLoading(false);
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
