import { useCallback, useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
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

const SECTIONS_KEY = 'lm_sidebar_collapsed_sections';
/* These two start collapsed on every load, whatever was left open last time
   (explicit request 2026-10-05). Opening one still works for the session, and
   landing on a page inside one opens it. */
const ALWAYS_COLLAPSED = ['Reports', 'Admin'];

/** Which section headings are collapsed — persisted, everything open by default. */
function useCollapsedSections(activePath, groups) {
  const [collapsed, setCollapsed] = useState(() => {
    try { return new Set([...JSON.parse(localStorage.getItem(SECTIONS_KEY) || '[]'), ...ALWAYS_COLLAPSED]); } catch (e) { return new Set(ALWAYS_COLLAPSED); }
  });
  useEffect(() => {
    try { localStorage.setItem(SECTIONS_KEY, JSON.stringify([...collapsed])); } catch (e) { /* best-effort */ }
  }, [collapsed]);

  /* Landing on a page (a link, a dashboard button, a deep link) opens the
     section it lives in, so the highlighted item is never hidden. Keyed on the
     path only — the user can still collapse it afterwards. */
  const activeLabel = groups.find((g) => g.items.some((it) => {
    const paths = it.path ? [it.path] : (it.children || []).map((c) => c.path);
    return paths.some((p) => activePath === p || activePath.startsWith(`${p}/`));
  }))?.label;
  useEffect(() => {
    if (!activeLabel) return;
    setCollapsed((prev) => {
      if (!prev.has(activeLabel)) return prev;
      const next = new Set(prev);
      next.delete(activeLabel);
      return next;
    });
  }, [activePath, activeLabel]);

  const toggle = useCallback((label) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label); else next.add(label);
      return next;
    });
  }, []);
  return { isCollapsed: (label) => collapsed.has(label), toggle };
}

function Leaf({ item, onNavigate, badge }) {
  return (
    <NavLink
      to={item.path}
      className={({ isActive }) => `${styles.navItem} ${isActive ? styles.active : ''}`}
      onClick={onNavigate}
      title={item.label}
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
 * sidebarKey is always visible. A branch is hidden entirely once none of its
 * children are visible to this user.
 *
 * EXCEPTION (explicit request 2026-09-30): an item may ALSO carry `permKey`,
 * additionally gating its visibility on the Permissions grid — used only for
 * Roles & Access ('rolesAdmin') and API Access ('apiAdmin'), so these two
 * admin-only entries disappear from the menu entirely for non-admins instead
 * of just rendering an "Access Restricted" page after the click. Both these
 * items ALSO carry their own `sidebarKey` (added the same day, as a second,
 * independent toggle) — for them specifically, sidebarKey AND permKey must
 * both allow it. Not a general-purpose mechanism: do not add `permKey` to
 * Renew & Document/Off-Lease or any other item without the user asking
 * again, per this file's 2026-08-05 decision above.
 */
export function Sidebar({ open, onNavigate }) {
  const { canView, canAct } = usePermission();
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
  // 'off-lease' added alongside 'deployed-sheet' — a Stage 1-8 action
  // (approve, complete a stage, move, hold) never touches the Deployed
  // sheet, so it wouldn't otherwise reach this badge until the next poll.
  useAutoRefresh(['deployed-sheet', 'off-lease'], reloadCounts);
  const visible = (item) =>
    (item.sidebarKey ? canView(item.sidebarKey) : true) &&
    (item.permKey ? canAct(item.permKey) : true);

  const visibleItems = NAV_TREE.items.filter((item) => !item.hidden && (item.children || visible(item)));
  const sections = [];
  for (const item of visibleItems) {
    const label = item.section || '';
    let group = sections.find((s) => s.label === label);
    if (!group) { group = { label, items: [] }; sections.push(group); }
    group.items.push(item);
  }

  const { pathname } = useLocation();
  // Collapsed on desktop = an icon rail: every item stays reachable as an icon,
  // so the accordion state is ignored and the headings become thin dividers.
  const rail = !open;
  const { isCollapsed, toggle: toggleSection } = useCollapsedSections(pathname, sections);

  return (
    <aside className={`${styles.sidebar} ${open ? styles.open : ''}`}>
      <div className={styles.brand}>
        <span className={styles.brandMark}><Icon name="container" size="sm" /></span>
        <span className={styles.brandText}>{NAV_TREE.label}</span>
      </div>
      <nav className={styles.nav}>
        {sections.map((group) => (
          <div key={group.label || '_'} className={styles.section}>
            {group.label && rail && <div className={styles.railDivider} aria-hidden="true" />}
            {group.label && !rail && (() => {
              const open = !isCollapsed(group.label);
              // A collapsed heading still shows how much is waiting inside it.
              const waiting = open ? 0 : group.items.reduce((sum, it) => sum + (it.children ? 0 : badgeValue(it, counts)), 0);
              return (
                <button
                  type="button"
                  className={styles.sectionToggle}
                  aria-expanded={open}
                  onClick={() => toggleSection(group.label)}
                >
                  <span className={styles.sectionToggleLabel}>{group.label}</span>
                  {waiting > 0 && <span className={styles.navBadge}>{waiting}</span>}
                  <Icon name="chev-down" size="sm" className={`${styles.chevron} ${open ? styles.chevronOpen : ''}`} />
                </button>
              );
            })()}
            {(!group.label || rail || !isCollapsed(group.label)) && group.items.map((item) => {
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
