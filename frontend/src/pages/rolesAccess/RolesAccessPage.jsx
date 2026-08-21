import { useCallback, useEffect, useState } from 'react';
import { PageHeader, Card, Button, EmptyState, ErrorState, ConfirmDialog } from '../../components/ui/index.js';
import { SkeletonTable } from '../../components/ui/Skeleton.jsx';
import { apiErrorMessage } from '../../shared/auth/index.js';
import * as rolesService from '../../services/roles.service.js';
import { AddAccountForm } from './AddAccountForm.jsx';
import { PermissionGrid } from './PermissionGrid.jsx';
import { SidebarGrid } from './SidebarGrid.jsx';
import styles from './RolesAccessPage.module.css';

const SUB_TABS = [
  { key: 'team', label: 'Team accounts' },
  { key: 'grid', label: 'Access Grid' }
];

/**
 * Roles & Access — admin-only, direct per-email grid (same real backend as
 * the main app's Roles & Access page: backend/src/routes/roles.routes.js,
 * gated server-side by roles.service.js's assertRolesAdmin). Edits save
 * instantly — each checkbox click is its own immediately-persisted call.
 */
export function RolesAccessPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [forbidden, setForbidden] = useState(false);
  const [subTab, setSubTab] = useState('team');
  const [removeTarget, setRemoveTarget] = useState(null); // { email, name }
  const [removeBusy, setRemoveBusy] = useState(false);
  const [toast, setToast] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    setForbidden(false);
    try {
      const res = await rolesService.fetchRolesAndAccess();
      setData(res);
    } catch (e) {
      if (e?.response?.status === 403) setForbidden(true);
      else setError(apiErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const handleTogglePerm = async (email, key, value) => {
    setData((prev) => {
      if (!prev) return prev;
      const acct = prev.emailPerms[email] || { name: '', allAccess: false, perms: {} };
      const nextAcct = key === 'allAccess'
        ? { ...acct, allAccess: value }
        : { ...acct, perms: { ...acct.perms, [key]: value } };
      return { ...prev, emailPerms: { ...prev.emailPerms, [email]: nextAcct } };
    });
    try {
      await rolesService.setEmailPermission(email, key, value);
    } catch (e) {
      setToast({ type: 'error', text: apiErrorMessage(e) });
      load(); // revert to server truth
    }
  };

  const handleToggleSidebar = async (email, key, label, value) => {
    setData((prev) => {
      if (!prev) return prev;
      const vis = prev.emailSidebar[email] || {};
      return { ...prev, emailSidebar: { ...prev.emailSidebar, [email]: { ...vis, [key]: value } } };
    });
    try {
      await rolesService.setEmailSidebar(email, key, value);
      setToast({ type: 'success', text: `${email} ${value ? 'can now see' : 'can no longer see'} "${label}"` });
    } catch (e) {
      setToast({ type: 'error', text: apiErrorMessage(e) });
      load();
    }
  };

  const handleAdd = async (email, name) => {
    await rolesService.addAccount(email, name);
    load();
  };

  const handleConfirmRemove = async () => {
    if (!removeTarget) return;
    setRemoveBusy(true);
    try {
      await rolesService.removeAccount(removeTarget.email);
      setToast({ type: 'success', text: 'Removed' });
      load();
    } catch (e) {
      setToast({ type: 'error', text: apiErrorMessage(e) });
    } finally {
      setRemoveBusy(false);
      setRemoveTarget(null);
    }
  };

  if (forbidden) {
    return (
      <>
        <PageHeader title="Roles & Access" subtitle="Admin-only: control what each email can see and do" />
        <Card><EmptyState message="Access Restricted" hint="Roles & Access is restricted to admins." /></Card>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Roles & Access" subtitle="Add an email, then tick exactly what that email can see and do. Edits save instantly." />

      {toast && (
        <div className={`${styles.banner} ${toast.type === 'success' ? styles.bannerSuccess : styles.bannerError}`}>
          {toast.text}
        </div>
      )}

      {loading && <Card><SkeletonTable columns={4} rows={6} /></Card>}
      {!loading && error && <Card><ErrorState message={error} onRetry={load} /></Card>}

      {!loading && !error && data && (
        <>
          <div className={styles.tabRow}>
            {SUB_TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                className={`${styles.tab} ${subTab === t.key ? styles.tabActive : ''}`}
                onClick={() => setSubTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>

          {subTab === 'team' && (
            <>
              <Card>
                <AddAccountForm onAdd={handleAdd} />
                <p className={styles.addHint}>
                  New email starts with everything unchecked — go to the <b>Access Grid</b> tab to tick what it can see/do.
                </p>
              </Card>
              <Card>
                {!data.team.length ? (
                  <EmptyState message="No accounts yet" />
                ) : (
                  <div className={styles.teamTableWrap}>
                    <table className={styles.teamTable}>
                      <thead>
                        <tr><th>Email</th><th>Name</th><th className={styles.centerHead}>Action</th></tr>
                      </thead>
                      <tbody>
                        {data.team.map((t) => (
                          <tr key={t.email}>
                            <td className={styles.emailCell}>{t.email}</td>
                            <td>{t.name || '—'}</td>
                            <td className={styles.centerCell}>
                              <Button variant="danger" size="sm" onClick={() => setRemoveTarget(t)}>Remove</Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </>
          )}

          {subTab === 'grid' && (
            <>
              <Card title="Permissions — what each email can do">
                <PermissionGrid
                  emails={data.emails}
                  permKeys={data.permKeys}
                  emailPerms={data.emailPerms}
                  onToggle={handleTogglePerm}
                />
              </Card>
              <Card title="Sidebar — what each email sees in the menu">
                <SidebarGrid
                  emails={data.emails}
                  sidebarKeys={data.sidebarKeys}
                  emailSidebar={data.emailSidebar}
                  onToggle={handleToggleSidebar}
                />
              </Card>
            </>
          )}
        </>
      )}

      <ConfirmDialog
        open={!!removeTarget}
        title="Remove access"
        message={removeTarget ? `Remove access for ${removeTarget.email}?` : ''}
        confirmLabel="Remove"
        danger
        loading={removeBusy}
        onConfirm={handleConfirmRemove}
        onClose={() => setRemoveTarget(null)}
      />
    </>
  );
}
