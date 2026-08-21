import { Icon } from './Icon.jsx';
import { SkeletonValue } from './Skeleton.jsx';
import styles from './StatCard.module.css';

/**
 * Shared "stat card" — design system section 25 (Cards): `.klabel` (icon +
 * label), `.kval` (the big number), `.kfoot` (a trend or plain footnote).
 * Pass `tint` ('navy'|'amber'|'success'|'error'|'warn'|'info'|'neutral') for
 * the borderless filled variant used for status-colored counts; omit for the
 * plain bordered variant. Pass `onClick` to make the label/value area act as
 * a button (hover lifts 3px per spec — only cards that act somewhere get
 * that treatment).
 *
 * `footnoteSegments` (instead of `footnote`) renders bold, individually
 * clickable chips — e.g. a breakdown that each drill into a different
 * sub-filter — rather than plain trend text. Kept as a sibling of the
 * label/value button (not nested inside it) so each chip's own onClick
 * fires without also triggering the card's main onClick.
 */
export function StatCard({
  icon, label, value, loading, trend, trendDirection = 'flat', footnote, footnoteSegments, tint, active, onClick
}) {
  const cls = [
    styles.card,
    onClick ? styles.hoverable : '',
    tint ? styles.tint : '',
    tint ? styles[`tint-${tint}`] : '',
    active ? styles.active : ''
  ].filter(Boolean).join(' ');
  const HitTag = onClick ? 'button' : 'div';
  const hasSegments = Array.isArray(footnoteSegments) && footnoteSegments.length > 0;

  return (
    <div className={cls}>
      <HitTag type={onClick ? 'button' : undefined} className={styles.hitArea} onClick={onClick}>
        <span className={styles.klabel}>
          {icon && <Icon name={icon} size="sm" />}
          {label}
        </span>
        <span className={styles.kval}>{loading ? <SkeletonValue /> : value}</span>
      </HitTag>
      {!loading && (trend || footnote) && !hasSegments && (
        <span className={styles.kfoot}>
          {trend && <span className={`${styles.trend} ${styles[trendDirection]}`}>{trend}</span>}
          {footnote}
        </span>
      )}
      {!loading && hasSegments && (
        <span className={styles.kfootSegments}>
          {footnoteSegments.map((s) => (
            <button
              key={s.key}
              type="button"
              className={[styles.segBtn, s.active ? styles.segBtnActive : ''].filter(Boolean).join(' ')}
              onClick={s.onClick}
            >
              {s.label}
            </button>
          ))}
        </span>
      )}
    </div>
  );
}
