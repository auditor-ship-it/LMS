import { useState } from 'react';
import { PageHeader, Card, Button, EmptyState, ErrorState } from '../../components/ui/index.js';
import { SkeletonTable } from '../../components/ui/Skeleton.jsx';
import { useAsync } from '../../hooks/useAsync.js';
import { apiErrorMessage } from '../../shared/auth/index.js';
import { fetchNewLeaseQueue, submitNewLeaseEntry, removeNewLeaseEntry } from '../../services/newLease.service.js';
import { formatActionTimestamp } from '../../utils/formatDateTime.js';
import { NewLeaseFormModal } from './NewLeaseFormModal.jsx';
import styles from '../offLease/PipelineDashboard.module.css';
import formStyles from './OffLeaseModal.module.css';

/**
 * "New Lease" — containers queued via the Off-Lease Container modal's
 * Location Change checkbox (OffLeaseModal.jsx), explicit request
 * 2026-11-16. Filling the form here appends a brand-new row to the
 * Deployed sheet for the new deployment; the old (now off-leased) row is
 * never touched.
 */
/** `embedded` — explicit request 2026-11-24 ("yah mujhe hai na lease
 *  expiry ke yaha tab de do"): New Lease moved from its own sidebar entry to
 *  a tab inside Lease Expiry (LeaseExpiryPage.jsx) — same convention
 *  StagePageBase's own `embedded` prop already uses to suppress its page's
 *  own title/subtitle when shown as a tab inside a parent page instead of
 *  standing alone. */
export function NewLeasePage({ embedded } = {}) {
  const { data, loading, error, reload } = useAsync(fetchNewLeaseQueue, []);
  const [target, setTarget] = useState(null);
  const [submitError, setSubmitError] = useState('');
  const [removingId, setRemovingId] = useState(null);

  const rows = data || [];

  const handleSubmitted = async (id, payload) => {
    const result = await submitNewLeaseEntry(id, payload);
    if (result === 'ALREADY_PROCESSED') {
      setSubmitError('This one was already completed.');
      setTarget(null);
      await reload();
      return;
    }
    setTarget(null);
    setSubmitError('');
    await reload();
  };

  /* Explicit request 2026-11-25 ("yah new lease se hathana hai kaise hathau
     bato") — a queued entry (e.g. a mistaken Location Change tick on the
     Off-Lease modal) can be removed without filling its form. Soft-marked
     'cancelled' on the backend, never deleted outright. */
  const handleRemove = async (id) => {
    if (!window.confirm('Remove this container from the New Lease queue? This cannot be undone.')) return;
    setRemovingId(id);
    try {
      const result = await removeNewLeaseEntry(id);
      if (result === 'ALREADY_PROCESSED') setSubmitError('This one was already completed.');
      else setSubmitError('');
      await reload();
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <>
      {!embedded && <PageHeader title="New Lease" subtitle="Containers pending redeployment at a new location" />}
      <Card>
        {loading && <SkeletonTable columns={4} rows={6} />}
        {!loading && error && <ErrorState message={apiErrorMessage(error)} onRetry={reload} />}
        {!loading && !error && rows.length === 0 && (
          <EmptyState message="Nothing pending" hint="A container shows up here once Off-Leased with Location Change checked." />
        )}
        {!loading && !error && rows.length > 0 && (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Container</th>
                  <th>Old Client</th>
                  <th>Old Location</th>
                  <th>Queued</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.containerNo}</td>
                    <td>{r.oldSnapshot?.clientName || '—'}</td>
                    <td>{r.oldSnapshot?.location || '—'}</td>
                    <td>{formatActionTimestamp(r.createdAt)}</td>
                    <td>
                      <Button size="sm" variant="primary" onClick={() => { setSubmitError(''); setTarget(r); }}>Fill New Lease</Button>{' '}
                      <Button size="sm" variant="danger" loading={removingId === r.id} onClick={() => handleRemove(r.id)}>Remove</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {submitError && <p className={formStyles.error}>{submitError}</p>}
      </Card>

      {target && (
        <NewLeaseFormModal
          entry={target}
          onClose={() => setTarget(null)}
          onSubmitted={handleSubmitted}
        />
      )}
    </>
  );
}
