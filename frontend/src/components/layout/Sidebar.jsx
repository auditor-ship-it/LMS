import { NavLink } from 'react-router-dom';
import { NAV_TREE } from '../../constants/nav.js';
import { useSidebarState } from '../../hooks/useSidebarState.js';
import { usePermission } from '../../hooks/usePermission.js';
import { useAsync } from '../../hooks/useAsync.js';
import { useAutoRefresh } from '../../hooks/useAutoRefresh.js';
import { fetchMyTasks } from '../../services/myTask.service.js';
import { Icon } from '../ui/Icon.jsx';
import styles from './Sidebar.module.css';

// Off-Lease has no single taskKey — its pending work is spread across the
// approval queue plus all 8 stages, so it sums them instead of reading one field.
function badgeValue(item, counts) {
  if (!counts) return 0;
  if (item.key === 'offLease') {
    return (counts.offleaseApproval || 0) + [1, 2, 3, 4, 5, 6, 7, 8]
      .reduce((sum, n) => sum + (counts[`olStage${n}`] || 0), 0);
  }
  return item.taskKey ? (counts[item.taskKey] || 0) : 0;
}

function Leaf({ item, onNavigate, badge }) {
  return (
    <NavLink
      to={item.path}
      className={({ isActive }) => `${styles.navItem} ${isActive ? styles.active : ''}`}
      onClick={onNavigate}
    >
      {item.icon && <Icon name={item.icon} className={styles.navIcon} />}
      <span className={styles.navLabel}>{item.label}</span>
      {badge > 0 && <span className={styles.navBadge}>{badge}</span>}
    </NavLink>
  );
}

function Branch({ item, visibleChildren, onNavigate }) {
  const { isExpanded, toggle } = useSidebarState();
  const expanded = isExpanded(item.key);

  return (
    <div className={styles.branch}>
      <button type="button" className={styles.branchToggle} onClick={() => toggle(item.key)}>
        <Icon name={item.icon} className={styles.navIcon} />
        <span className={styles.branchLabel}>{item.label}</span>
        <Icon name="chev-down" size="sm" className={`${styles.chevron} ${expanded ? styles.chevronOpen : ''}`} />
      </button>
      {expanded && (
        <div className={styles.branchChildren}>
          {visibleChildren.map((child) => <Leaf key={child.key} item={child} onNavigate={onNavigate} />)}
        </div>
      )}
    </div>
  );
}

/**
 * Menu visibility: the Roles & Access "Sidebar" grid checkbox is the sole
 * source of truth for every item with a `sidebarKey` — checked there means
 * visible, independent of the separate Permissions grid. An item with no
 * sidebarKey (Roles & Access) is always visible. A branch is hidden entirely
 * once none of its children are visible to this user.
 */
export function Sidebar({ open, onNavigate }) {
  const { canView } = usePermission();
  const { data: counts, reload: reloadCounts } = useAsync(fetchMyTasks, []);
  // BUG FOUND AND FIXED 2026-09-03: unlike every other page, Sidebar never
  // refetched after its initial mount — it's part of the persistent app
  // shell (mounted once per session, not remounted on navigation), so its
  // nav badges (e.g. "Renew & Document") were effectively a snapshot frozen
  // at login and never updated again, no matter what actions happened
  // elsewhere in the app for the rest of the session. Confirmed live: the
  // Renew & Document page's own KPI correctly showed 8 while this sidebar's
  // badge still read a stale 6 from first load. Subscribing here, same
  // pattern every page already uses for its own data.
  useAutoRefresh('deployed-sheet', reloadCounts);
  const visible = (item) => (item.sidebarKey ? canView(item.sidebarKey) : true);

  const visibleItems = NAV_TREE.items.filter((item) => item.children || visible(item));
  const sections = [];
  for (const item of visibleItems) {
    const label = item.section || '';
    let group = sections.find((s) => s.label === label);
    if (!group) { group = { label, items: [] }; sections.push(group); }
    group.items.push(item);
  }

  return (
    <aside className={`${styles.sidebar} ${open ? styles.open : ''}`}>
      <div className={styles.brand}>
        <span className={styles.brandMark}><Icon name="container" size="sm" /></span>
        <span className={styles.brandText}>{NAV_TREE.label}</span>
      </div>
      <nav className={styles.nav}>
        {sections.map((group) => (
          <div key={group.label || '_'} className={styles.section}>
            {group.label && <div className={styles.sectionLabel}>{group.label}</div>}
            {group.items.map((item) => {
              if (item.children) {
                const visibleChildren = item.children.filter(visible);
                if (!visibleChildren.length) return null;
                return <Branch key={item.key} item={item} visibleChildren={visibleChildren} onNavigate={onNavigate} />;
              }
              return <Leaf key={item.key} item={item} onNavigate={onNavigate} badge={badgeValue(item, counts)} />;
            })}
          </div>
        ))}
      </nav>
    </aside>
  );
}
