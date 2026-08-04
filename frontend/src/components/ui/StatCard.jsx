import { Icon } from './Icon.jsx';
import styles from './StatCard.module.css';

/**
 * Shared "stat card" — design system section 25 (Cards): `.klabel` (icon +
 * label), `.kval` (the big number), `.kfoot` (a trend or plain footnote).
 * Pass `tint` ('navy'|'amber'|'success'|'error'|'warn'|'info'|'neutral') for
 * the borderless filled variant used for status-colored counts; omit for the
 * plain bordered variant. Pass `onClick` to render it as a button (hover
 * lifts 3px per spec — only cards that act somewhere get that treatment).
 */
export function StatCard({ icon, label, value, trend, trendDirection = 'flat', footnote, tint, active, onClick }) {
  const Tag = onClick ? 'button' : 'div';
  const cls = [
    styles.card,
    onClick ? styles.hoverable : '',
    tint ? styles.tint : '',
    tint ? styles[`tint-${tint}`] : '',
    active ? styles.active : ''
  ].filter(Boolean).join(' ');

  return (
    <Tag type={onClick ? 'button' : undefined} className={cls} onClick={onClick}>
      <span className={styles.klabel}>
        {icon && <Icon name={icon} size="sm" />}
        {label}
      </span>
      <span className={styles.kval}>{value}</span>
      {(trend || footnote) && (
        <span className={styles.kfoot}>
          {trend && <span className={`${styles.trend} ${styles[trendDirection]}`}>{trend}</span>}
          {footnote}
        </span>
      )}
    </Tag>
  );
}
