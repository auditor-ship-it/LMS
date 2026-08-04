import { useState } from 'react';
import { Sidebar } from './Sidebar.jsx';
import { TopBar } from './TopBar.jsx';
import { Breadcrumbs } from './Breadcrumbs.jsx';
import { KeepAlivePages } from './KeepAlivePages.jsx';
import { useSwipeSidebar } from '../../hooks/useSwipeSidebar.js';
import styles from './AppShell.module.css';

/**
 * One `sidebarOpen` boolean drives the sidebar everywhere — on desktop it
 * width-collapses in place (freeing up space for wide tables), on mobile it
 * slides in as an overlay drawer (see Sidebar.module.css's two @media
 * blocks). Starts open on desktop, closed on mobile, matching what each
 * form factor expects on first load.
 */
export function AppShell() {
  const [sidebarOpen, setSidebarOpen] = useState(
    () => typeof window === 'undefined' || window.matchMedia('(min-width: 901px)').matches
  );
  const swipe = useSwipeSidebar(sidebarOpen, setSidebarOpen);

  return (
    <div className={styles.shell} {...swipe}>
      <Sidebar open={sidebarOpen} onNavigate={() => setSidebarOpen(window.matchMedia('(min-width: 901px)').matches)} />
      <div className={`${styles.scrim} ${sidebarOpen ? styles.scrimOn : ''}`} onClick={() => setSidebarOpen(false)} />
      <div className={styles.main}>
        <TopBar sidebarOpen={sidebarOpen} onMenuClick={() => setSidebarOpen((v) => !v)} />
        <div className={styles.content}>
          <Breadcrumbs />
          <KeepAlivePages />
        </div>
      </div>
    </div>
  );
}
