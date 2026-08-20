import { useCallback, useEffect, useState } from 'react';
import { PageHeader, Card, Button, LoadingState, EmptyState, ErrorState, ConfirmDialog, Modal } from '../../components/ui/index.js';
import { apiErrorMessage } from '../../shared/auth/index.js';
import * as apiKeysService from '../../services/apiKeys.service.js';
import { CreateKeyForm } from './CreateKeyForm.jsx';
import { NewKeyReveal } from './NewKeyReveal.jsx';
import styles from './ApiAccessPage.module.css';

const DOMAIN_LABELS = {
  leases: 'Leases (Verify / Approve / Expiry)',
  offlease: 'Off-Lease Pipeline',
  accounts: 'Accounts / Invoice Ledger',
  all: 'All domains'
};

const PUBLIC_BASE = `${(import.meta.env.VITE_API_URL || 'http://localhost:4001/api').replace(/\/api\/?$/, '')}/api/public/v1`;

const ENDPOINTS = [
  { domain: 'leases', method: 'GET', path: '/leases/verify' },
  { domain: 'leases', method: 'GET', path: '/leases/approve' },
  { domain: 'leases', method: 'GET', path: '/leases/approve/history' },
  { domain: 'leases', method: 'GET', path: '/leases/expiry?filter=pending' },
  { domain: 'leases', method: 'POST', path: '/leases/verify/:containerNo/action', write: true },
  { domain: 'leases', method: 'POST', path: '/leases/approve/:containerNo/action', write: true },
  { domain: 'leases', method: 'POST', path: '/leases/expiry/action', write: true },
  { domain: 'offlease', method: 'GET', path: '/offlease/dashboard' },
  { domain: 'offlease', method: 'GET', path: '/offlease/stage?stage=1' },
  { domain: 'offlease', method: 'GET', path: '/offlease/approval' },
  { domain: 'offlease', method: 'GET', path: '/offlease/:containerNo/detail' },
  { domain: 'offlease', method: 'POST', path: '/offlease/:containerNo/stage/:stage', write: true },
  { domain: 'offlease', method: 'POST', path: '/offlease/:containerNo/approval', write: true },
  { domain: 'accounts', method: 'GET', path: '/accounts/:containerNo/outstanding' }
];

/** e.g. "leases:write" -> "Leases (Verify / Approve / Expiry) — Write" */
function scopeLabel(scope) {
  if (scope.endsWith(':write')) {
    const domain = scope.replace(/:write$/, '');
    return `${DOMAIN_LABELS[domain] || domain} — Write`;
  }
  return DOMAIN_LABELS[scope] || scope;
}

function fmtDate(v) {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * Admin screen for the public, read-only, key-gated API (backend:
 * routes/public.routes.js). Same admin-only convention as Roles & Access —
 * server-side gate (apiKeys.controller.js's assertApiSuperAdmin, HTTP 403),
 * this page turns a 403 into an "Access Restricted" state rather than
 * hiding itself from the nav (see constants/nav.js's comment on that).
 *
 * The raw key is shown exactly once, right after creation (NewKeyReveal) —
 * the backend never stores or returns it again, same as a GitHub PAT.
 */
export function ApiAccessPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [forbidden, setForbidden] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [newKey, setNewKey] = useState(null);
  const [revokeTarget, setRevokeTarget] = useState(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [docsOpen, setDocsOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    setForbidden(false);
    try {
      const res = await apiKeysService.fetchApiKeys();
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

  const handleCreate = async (label, scopes, actsAsEmail) => {
    const created = await apiKeysService.addApiKey(label, scopes, actsAsEmail);
    setCreateOpen(false);
    setNewKey(created);
    load();
  };

  const handleConfirmRevoke = async () => {
    if (!revokeTarget) return;
    setRevokeBusy(true);
    try {
      await apiKeysService.removeApiKey(revokeTarget.id);
      setToast({ type: 'success', text: `"${revokeTarget.label}" revoked — that key can no longer read or write anything.` });
      load();
    } catch (e) {
      setToast({ type: 'error', text: apiErrorMessage(e) });
    } finally {
      setRevokeBusy(false);
      setRevokeTarget(null);
    }
  };

  if (forbidden) {
    return (
      <>
        <PageHeader title="API Access" subtitle="Admin-only: issue and manage public read-only API keys" />
        <Card><EmptyState message="Access Restricted" hint="API Access is restricted to admins." /></Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="API Access"
        subtitle="Issue API keys for external systems — each key is scoped per-domain to read, or read & write, and can be revoked instantly."
      />

      {toast && (
        <div className={`${styles.banner} ${toast.type === 'success' ? styles.bannerSuccess : styles.bannerError}`}>
          {toast.text}
        </div>
      )}

      <Card
        title="Public API keys"
        actions={(
          <>
            <Button variant="secondary" size="sm" onClick={() => setDocsOpen(true)}>How to use a key</Button>
            <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>+ Create key</Button>
          </>
        )}
      >
        {loading && <LoadingState label="Loading API keys…" />}
        {!loading && error && <ErrorState message={error} onRetry={load} />}
        {!loading && !error && data && !data.keys.length && (
          <EmptyState message="No API keys yet" hint="Create one to give an external system scoped access to this app's data." />
        )}
        {!loading && !error && data && !!data.keys.length && (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Label</th>
                  <th>Key</th>
                  <th>Scope</th>
                  <th>Created</th>
                  <th>Last used</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.keys.map((k) => (
                  <tr key={k.id} className={k.revoked ? styles.revokedRow : ''}>
                    <td className={styles.labelCell}>{k.label}</td>
                    <td><code className={styles.keyCode}>{k.keyPreview}</code></td>
                    <td>
                      <div className={styles.scopeWrap}>
                        {k.scopes.map((s) => (
                          <span key={s} className={`${styles.scopeChip} ${s.endsWith(':write') ? styles.scopeChipWrite : ''}`}>
                            {scopeLabel(s)}
                          </span>
                        ))}
                      </div>
                      {k.actsAsEmail && <div className={styles.actsAsNote}>writes as {k.actsAsEmail}</div>}
                    </td>
                    <td className={styles.dimCell}>{fmtDate(k.createdAt)}<br /><span className={styles.byWhom}>{k.createdBy}</span></td>
                    <td className={styles.dimCell}>{fmtDate(k.lastUsedAt)}</td>
                    <td>
                      {k.revoked
                        ? <span className={styles.statusRevoked}>Revoked</span>
                        : <span className={styles.statusActive}>Active</span>}
                    </td>
                    <td className={styles.actionCell}>
                      {!k.revoked && (
                        <Button variant="danger" size="sm" onClick={() => setRevokeTarget(k)}>Revoke</Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Create API key" width="520px">
        <CreateKeyForm
          domains={data?.domains || []}
          writeCapableDomains={data?.writeCapableDomains || []}
          domainLabels={DOMAIN_LABELS}
          onCreate={handleCreate}
          onCancel={() => setCreateOpen(false)}
        />
      </Modal>

      <Modal open={!!newKey} onClose={() => setNewKey(null)} title="API key created" width="560px">
        {newKey && <NewKeyReveal keyInfo={newKey} onDone={() => setNewKey(null)} />}
      </Modal>

      <Modal open={docsOpen} onClose={() => setDocsOpen(false)} title="Using a public API key" width="680px">
        <div className={styles.docs}>
          <p className={styles.docsIntro}>
            Send the key in the <code>X-Api-Key</code> header. No LMS login/session is needed — the key alone
            identifies the caller and what it's allowed to do. Limited to 120 requests/minute per key.
          </p>
          <pre className={styles.docsCode}>{`curl "${PUBLIC_BASE}/offlease/dashboard" \\\n  -H "X-Api-Key: lms_pub_..."`}</pre>
          <p className={styles.docsIntro}>
            <b>POST</b> routes below need that domain&apos;s <b>Write</b> scope and run as the real LMS user named on
            the key when it was created — same body shape as the matching form in the app.
          </p>
          <pre className={styles.docsCode}>{`curl -X POST "${PUBLIC_BASE}/offlease/CONTAINER123/approval" \\\n  -H "X-Api-Key: lms_pub_..." -H "Content-Type: application/json" \\\n  -d '{"status":"Approved"}'`}</pre>
          <div className={styles.docsEndpoints}>
            {ENDPOINTS.map((e) => (
              <div key={e.path} className={styles.docsRow}>
                <span className={styles.docsDomain}>{e.domain}</span>
                <code className={`${styles.docsPath} ${e.write ? styles.docsPathWrite : ''}`}>{e.method} {PUBLIC_BASE}{e.path}</code>
              </div>
            ))}
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!revokeTarget}
        title="Revoke API key"
        message={revokeTarget ? `Revoke "${revokeTarget.label}"? Anything using this key will immediately lose access${revokeTarget.actsAsEmail ? ` (including write access acting as ${revokeTarget.actsAsEmail})` : ''}. This can't be undone — a new key would need to be issued and shared again.` : ''}
        confirmLabel="Revoke"
        danger
        loading={revokeBusy}
        onConfirm={handleConfirmRevoke}
        onClose={() => setRevokeTarget(null)}
      />
    </>
  );
}
