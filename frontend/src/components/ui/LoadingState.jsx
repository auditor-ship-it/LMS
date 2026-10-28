import { useEffect, useState } from 'react';
import styles from './States.module.css';

// Explicit request 2026-10-28 ("timer atual time pta calega kitne sec mai
// ho ragha hai", re: the "Loading stage data…" spinner): opt-in so this
// doesn't change the many other LoadingState call sites that didn't ask
// for it. Follow-up same day ("sec . mili sec"): show milliseconds too,
// not whole seconds — ticks every 50ms instead of every 1s.
export function LoadingState({ label = 'Loading…', showElapsed = false }) {
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    if (!showElapsed) return undefined;
    const start = Date.now();
    setElapsedMs(0);
    const id = setInterval(() => setElapsedMs(Date.now() - start), 50);
    return () => clearInterval(id);
  }, [showElapsed]);

  const elapsedLabel = `${Math.floor(elapsedMs / 1000)}.${String(Math.floor((elapsedMs % 1000) / 10)).padStart(2, '0')}s`;

  return (
    <div className={styles.wrap}>
      <div className={styles.spinner} />
      <span>{label}{showElapsed ? ` (${elapsedLabel})` : ''}</span>
    </div>
  );
}
