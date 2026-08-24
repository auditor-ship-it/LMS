import { useEffect, useRef } from 'react';

/**
 * Calls `reload` on a fixed interval while the owning component is mounted —
 * for pages whose backing data can change from OUTSIDE this app (an external
 * Google Form submission, an FMS sheet edit, another user editing the tab
 * directly) with no write-path in this app to invalidate() from. dataBus's
 * cross-page auto-refresh (useAutoRefresh) only fires on a write THIS app
 * made, so it cannot catch that class of change — this is what does.
 *
 * Scoped to Off-Lease only (2026-08-24, "optimize the stage workflow" ask).
 * Every other page keeps the explicit "RAW, no auto-refresh" model chosen
 * 2026-08-21 after the Renew & Document chip-flicker investigation — polling
 * is exactly the kind of extra moving part that caused that, so it stays
 * opt-in per page rather than becoming a default.
 *
 * Pass `() => reload({ silent: true })` from useAsync, not `reload` itself —
 * a plain reload flips `loading` true on every tick, which flashes a
 * full-page skeleton every interval instead of updating quietly.
 */
export function usePolling(reload, intervalMs = 60000, enabled = true) {
  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  useEffect(() => {
    if (!enabled) return undefined;
    const id = setInterval(() => reloadRef.current(), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, enabled]);
}
