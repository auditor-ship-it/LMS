import { useState } from 'react';
import { PageHeader, Card, Button, EmptyState, ErrorState } from '../../components/ui/index.js';
import { SkeletonTable } from '../../components/ui/Skeleton.jsx';
import { useAsync } from '../../hooks/useAsync.js';
import { apiErrorMessage } from '../../shared/auth/index.js';
import { fetchNewLeaseQueue, submitNewLeaseEntry } from '../../services/newLease.service.js';
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
export function NewLeasePage() {
  const { data, loading, error, reload } = useAsync(fetchNewLeaseQueue, []);
  const [target, setTarget] = useState(null);
  const [submitError, setSubmitError] = useState('');

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

  return (
    <>
      <PageHeader title="New Lease" subtitle="Containers pending redeployment at a new location" />
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
                      <Button size="sm" variant="primary" onClick={() => { setSubmitError(''); setTarget(r); }}>Fill New Lease</Button>
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
