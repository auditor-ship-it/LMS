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

  const run = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetcher();
      if (mounted.current) setData(res);
    } catch (e) {
      if (mounted.current) setError(apiErrorMessage(e));
    } finally {
      if (mounted.current) setLoading(false);
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
