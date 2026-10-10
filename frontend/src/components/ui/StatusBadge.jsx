import styles from './StatusBadge.module.css';

/* Status is only ever one of the 4 semantic tokens — success/error/warn/info — never
   an arbitrary color, per the design system's "status colours are status only" rule. */
const MAP = {
  pending: 'warn',
  'documents pending': 'warn',
  'renew pending': 'warn',
  approved: 'ok',
  completed: 'ok',
  paid: 'ok',
  rejected: 'bad',
  'sent back': 'warn',
  overdue: 'bad',
  disputed: 'bad',
  renewed: 'info',
  'in progress': 'info',
  // Lease Expiry ageing bands (server-computed `band` field).
  critical: 'bad',
  warning: 'warn',
  safe: 'ok'
};

/* Sheet/API still store "Documents Pending"; show "Renew Pending" in the UI
   so Renewal Status matches the My Task tile wording. */
const LABEL = {
  'documents pending': 'Renew Pending'
};

/** `dot`: a small leading status dot instead of a filled pill — opt-in (default
 *  off) so every existing caller keeps its current look; pass it where that
 *  reads better against a dense table row. */
export function StatusBadge({ status, dot = false }) {
  const key = String(status || '').trim().toLowerCase();
  const color = MAP[key] || 'neutral';
  const label = LABEL[key] || status || '—';
  return (
    <span className={`${styles.badge} ${styles[color]} ${dot ? styles.dotted : ''}`}>
      {dot && <i className={styles.dot} aria-hidden="true" />}
      {label}
    </span>
  );
}
