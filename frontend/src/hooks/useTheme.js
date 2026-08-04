import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'lms-theme';

function readTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

/** Reads/toggles the [data-theme] attribute index.html's bootstrap script sets before paint. */
export function useTheme() {
  const [theme, setThemeState] = useState(readTheme);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem(STORAGE_KEY, theme); } catch (e) { /* private mode etc — theme just won't persist */ }
  }, [theme]);

  const toggle = useCallback(() => {
    setThemeState((t) => (t === 'dark' ? 'light' : 'dark'));
  }, []);

  return { theme, toggle };
}
