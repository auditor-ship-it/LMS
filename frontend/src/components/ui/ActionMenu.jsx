import { useEffect, useRef, useState } from 'react';
import styles from './ActionMenu.module.css';

/** A small "⋯" dropdown of row actions — `actions` is [{label, onClick, danger}]. */
export function ActionMenu({ actions = [] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  if (!actions.length) return null;

  return (
    <div className={styles.wrap} ref={ref}>
      <button type="button" className={styles.trigger} onClick={() => setOpen((v) => !v)} aria-label="Row actions">⋯</button>
      {open && (
        <div className={styles.menu}>
          {actions.map((a, i) => (
            <button
              key={i}
              type="button"
              className={`${styles.item} ${a.danger ? styles.danger : ''}`}
              onClick={() => { setOpen(false); a.onClick(); }}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
