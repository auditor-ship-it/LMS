import styles from './Skeleton.module.css';

/**
 * A shimmering placeholder block, using the design system's own --skel-a/
 * --skel-b tokens (tokens.css already defined these for exactly this, just
 * unused until now). Reach for SkeletonTable/SkeletonRows for the common
 * shapes below; use this directly only for something bespoke.
 */
export function Skeleton({ width = '100%', height = 14, radius = 4, className = '' }) {
  return (
    <span
      className={`${styles.skel} ${className}`}
      style={{
        width,
        height: typeof height === 'number' ? `${height}px` : height,
        borderRadius: typeof radius === 'number' ? `${radius}px` : radius
      }}
    />
  );
}

// Varied so a block of skeleton rows doesn't read as one uniform gray slab —
// real cell content is rarely all the same width.
const WIDTHS = ['82%', '58%', '70%', '44%', '90%', '63%', '76%'];

/** Placeholder rows matching DataGrid's shape — `columns` cells per row. */
export function SkeletonTable({ columns = 5, rows = 8 }) {
  return (
    <div className={styles.tableWrap} aria-hidden="true">
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className={styles.tableRow}>
          {Array.from({ length: columns }, (_, c) => (
            <Skeleton key={c} width={WIDTHS[(r + c) % WIDTHS.length]} height={13} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** A single skeleton line, sized for a StatCard's big value — drop-in for
 *  the number while its real value is still loading. */
export function SkeletonValue({ width = 56 }) {
  return <Skeleton className={styles.statValue} width={width} height={22} radius={5} />;
}

/** Placeholder record rows for card-per-record layouts (e.g. the Off-Lease
 *  order book) that don't fit a table shape — a title line, a strip of chip
 *  placeholders, and a shorter detail line per card. */
export function SkeletonCards({ count = 5 }) {
  return (
    <div className={styles.cardsWrap} aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={styles.cardRow}>
          <Skeleton width={i % 2 ? '38%' : '46%'} height={15} />
          <div className={styles.cardChips}>
            {Array.from({ length: 8 }, (_, c) => <Skeleton key={c} width={26} height={26} radius={999} />)}
          </div>
          <Skeleton width="60%" height={12} />
        </div>
      ))}
    </div>
  );
}
