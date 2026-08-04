import { DataGrid } from '../../components/ui/index.js';
import styles from './RolesAccessPage.module.css';

/**
 * One row per sidebar visibility key (one per main-app nav tab), one
 * checkbox column per email. No "All Access" concept here — sidebar
 * visibility is separate from action permissions.
 */
export function SidebarGrid({ emails, sidebarKeys, emailSidebar, onToggle }) {
  if (!emails.length) return null;

  return (
    <DataGrid
      headers={['Menu item', ...emails]}
      rows={sidebarKeys}
      rowKey={(r) => r.key}
      renderRow={(_, r) => (
        <>
          <td className={styles.rowLabelCell}>{r.label}</td>
          {emails.map((email) => {
            const vis = emailSidebar[email] || {};
            const checked = !!vis[r.key];
            return (
              <td key={email} className={styles.checkCell}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => onToggle(email, r.key, r.label, e.target.checked)}
                />
              </td>
            );
          })}
        </>
      )}
    />
  );
}
