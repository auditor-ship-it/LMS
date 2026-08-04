import { useEffect } from 'react';
import styles from './Modal.module.css';

/** Minimal, dependency-free modal shell — backdrop click / Escape both close it. */
export function Modal({ open, onClose, title, width = '480px', children }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className={styles.overlay} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className={styles.panel} style={{ maxWidth: width }} role="dialog" aria-modal="true" aria-label={title}>
        <div className={styles.header}>
          <h3 className={styles.title}>{title}</h3>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className={styles.body}>{children}</div>
      </div>
    </div>
  );
}
