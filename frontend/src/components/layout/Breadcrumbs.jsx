import { useLocation } from 'react-router-dom';
import { trailFor } from '../../utils/breadcrumbs.js';
import { Icon } from '../ui/Icon.jsx';
import styles from './Breadcrumbs.module.css';

/**
 * The design system's breadcrumb pattern: an icon (never the word "Home")
 * for the root position, `i-chev-right` separators instead of a literal
 * "/", and the current crumb rendered as accent-colored non-link text. This
 * app's trail is never deeper than 3 levels (see breadcrumbs.js), so the
 * spec's >4-level "···" collapse menu doesn't apply here.
 */
export function Breadcrumbs() {
  const { pathname } = useLocation();
  const trail = trailFor(pathname);

  return (
    <nav className={styles.wrap} aria-label="Breadcrumb">
      {trail.map((label, i) => (
        <span key={i} className={styles.segment}>
          {i === 0 ? (
            <span aria-label={label}><Icon name="home" size="sm" className={styles.homeIcon} /></span>
          ) : (
            <Icon name="chev-right" size="sm" className={styles.sep} />
          )}
          {i > 0 && <span className={i === trail.length - 1 ? styles.current : styles.crumb}>{label}</span>}
        </span>
      ))}
    </nav>
  );
}
