import styles from './StatusBadge.module.css';

/* Status is only ever one of the 4 semantic tokens — success/error/warn/info — never
   an arbitrary color, per the design system's "status colours are status only" rule. */
const MAP = {
  pending: 'warn',
  'documents pending': 'warn',
  approved: 'ok',
  completed: 'ok',
  paid: 'ok',
  rejected: 'bad',
  overdue: 'bad',
  disputed: 'bad',
  renewed: 'info',
  'in progress': 'info',
  // Lease Expiry ageing bands (server-computed `band` field).
  critical: 'bad',
  warning: 'warn',
  safe: 'ok'
};

export function StatusBadge({ status }) {
  const key = String(status || '').trim().toLowerCase();
  const color = MAP[key] || 'neutral';
  return <span className={`${styles.badge} ${styles[color]}`}>{status || '—'}</span>;
}
