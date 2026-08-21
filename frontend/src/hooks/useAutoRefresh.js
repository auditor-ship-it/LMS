import { useEffect, useRef } from 'react';
import { subscribe } from '../shared/dataBus.js';

/**
 * Subscribes `reload` to dataBus invalidation events for `domains` and
 * refetches immediately whenever one fires — whether or not this page is
 * the one currently on screen. These reads come from the fast Mongo mirror,
 * not live Google Sheets, so there's no real cost to keeping a
 * kept-alive-but-hidden page's data current in the background; the
 * alternative (only refetch once this page becomes active again) meant a
 * page you switch to right after an action elsewhere could still show
 * stale data for as long as it takes you to notice and navigate there —
 * confirmed 2026-08-20: one test landed near-instantly, a near-identical
 * one ~90s later, entirely dependent on which page happened to be on
 * screen when the write completed.
 *
 * `domains` is a string or array of strings, matching whatever a writer
 * passed to dataBus's invalidate().
 */
export function useAutoRefresh(domains, reload) {
  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  useEffect(() => {
    const doms = Array.isArray(domains) ? domains : [domains];
    const unsubs = doms.map((d) => subscribe(d, () => reloadRef.current()));
    return () => unsubs.forEach((u) => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Array.isArray(domains) ? domains.join(',') : domains]);
}
