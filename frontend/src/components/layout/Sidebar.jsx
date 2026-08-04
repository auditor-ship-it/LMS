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
 * Role-based menu visibility, matching the real app's Roles & Access system:
 * an item with a `sidebarKey` (My Task/Verify/Approve/Lease Expiry — the ones
 * the admin's "Sidebar" grid has an explicit per-email toggle for) uses
 * canView(), same as the main app. An item with only a `permKey` (Renew &
 * Document, Off-Lease, each Stage — no dedicated sidebar toggle exists for
 * these) falls back to canAct(), the same action permission its own buttons
 * already gate on. An item with neither is always visible. A branch (Stages)
 * is hidden entirely once none of its children are visible to this user.
 */
export function Sidebar({ open, onNavigate }) {
  const { canView, canAct } = usePermission();
  const visible = (item) => {
    if (item.sidebarKey) return canView(item.sidebarKey);
    if (item.permKey) return canAct(item.permKey);
    return true;
  };

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
