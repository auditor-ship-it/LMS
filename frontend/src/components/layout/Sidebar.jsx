import { NavLink } from 'react-router-dom';
import { NAV_TREE } from '../../constants/nav.js';
import { useSidebarState } from '../../hooks/useSidebarState.js';
import { usePermission } from '../../hooks/usePermission.js';
import { Icon } from '../ui/Icon.jsx';
import styles from './Sidebar.module.css';

function Leaf({ item, onNavigate }) {
  return (
    <NavLink
      to={item.path}
      className={({ isActive }) => `${styles.navItem} ${isActive ? styles.active : ''}`}
      onClick={onNavigate}
    >
      {item.icon && <Icon name={item.icon} className={styles.navIcon} />}
      <span>{item.label}</span>
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
  const visible = (item) => (item.sidebarKey ? canView(item.sidebarKey) : true);

  return (
    <aside className={`${styles.sidebar} ${open ? styles.open : ''}`}>
      <div className={styles.brand}>
        <span className={styles.brandMark}><Icon name="container" size="sm" /></span>
        <span className={styles.brandText}>{NAV_TREE.label}</span>
      </div>
      <nav className={styles.nav}>
        {NAV_TREE.items.map((item) => {
          if (item.children) {
            const visibleChildren = item.children.filter(visible);
            if (!visibleChildren.length) return null;
            return <Branch key={item.key} item={item} visibleChildren={visibleChildren} onNavigate={onNavigate} />;
          }
          return visible(item) ? <Leaf key={item.key} item={item} onNavigate={onNavigate} /> : null;
        })}
      </nav>
    </aside>
  );
}
