import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'lm_sidebar_expanded'; // this app's own key, unrelated to the main app's storage

function loadExpanded() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : { stages: true };
  } catch (e) {
    return { stages: true };
  }
}

/** Persists which collapsible submenus (e.g. "Stages") are expanded, across reloads. */
export function useSidebarState() {
  const [expanded, setExpanded] = useState(loadExpanded);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(expanded)); } catch (e) { /* best-effort */ }
  }, [expanded]);

  const toggle = useCallback((key) => {
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const isExpanded = useCallback((key) => !!expanded[key], [expanded]);

  return { isExpanded, toggle };
}
