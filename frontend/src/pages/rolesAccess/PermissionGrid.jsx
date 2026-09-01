import { DataGrid, EmptyState } from '../../components/ui/index.js';
import styles from './RolesAccessPage.module.css';

/**
 * One row per action permission key (Verify/Approve/Expiry/Renew/Document/
 * Off-Lease stages 1-8/Off-Lease Approval/Billing/Receivables) plus a
 * synthetic "All Access" row on top, one checkbox column per email. All
 * Access checked => every other checkbox in that column shows checked and
 * disabled ("Covered by All Access").
 */
export function PermissionGrid({ emails, permKeys, emailPerms, onToggle }) {
  if (!emails.length) {
    return <EmptyState message="No emails yet" hint="Add one from the Team accounts tab" />;
  }

  const rows = [{ key: 'allAccess', label: 'All Access', isAllAccess: true }, ...permKeys];

  return (
    <DataGrid
      headers={[
        'What they can do',
        // Column is already scoped to one email per row below (onToggle,
        // emailPerms lookups) — this only shortens what's DISPLAYED. Strips
        // exactly "@crystalgroup.in", not any domain, so an account on a
        // different domain (if one ever exists) still shows in full rather
        // than silently truncating something that isn't actually redundant.
        ...emails.map((email) => {
          const short = email.replace(/@crystalgroup\.in$/i, '');
          return short === email ? email : <span key={email} title={email}>{short}</span>;
        })
      ]}
      rows={rows}
      rowKey={(r) => r.key}
      renderRow={(_, r) => (
        <>
          <td className={styles.rowLabelCell}>
            {r.label}
            {r.isAllAccess && <span className={styles.rowLabelHint}>Bypasses everything below</span>}
          </td>
          {emails.map((email) => {
            const acct = emailPerms[email] || { allAccess: false, perms: {} };
            const isAll = !!r.isAllAccess;
            const checked = isAll ? !!acct.allAccess : (!!acct.allAccess || !!acct.perms?.[r.key]);
            const disabled = !isAll && !!acct.allAccess;
            return (
              <td key={email} className={styles.checkCell}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  title={disabled ? 'Covered by All Access' : undefined}
                  onChange={(e) => onToggle(email, r.key, e.target.checked)}
                />
              </td>
            );
          })}
        </>
      )}
    />
  );
}
