import { PageHeader, Card, Button, ErrorState, EmptyState } from '../../components/ui/index.js';
import { SkeletonTable } from '../../components/ui/Skeleton.jsx';
import { useAsync } from '../../hooks/useAsync.js';
import { fetchSyncStatus } from '../../services/syncStatus.service.js';
import styles from './SyncStatusPage.module.css';

const STATUS_TONE = { pending: 'textInfo', processing: 'textInfo', failed: 'textWarn', dead: 'textBad', done: 'textOk' };

function fmtWhen(v) {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString();
}

/**
 * Sync Status — admin-only, explicit request 2026-10-17 ("there should be a
 * log that which [records] are left to be added in the sheet"). Read-only
 * view of _sync_outbox (outbox.service.js): every Mongo-first write
 * (saveOffLeaseStage, saveExpiryAction, …) lands in Mongo immediately and
 * queues a background replay against live Google Sheets — this page shows
 * what's still waiting on that replay, so a stuck or slow sync is visible
 * instead of silent.
 *
 * Building this surfaced two real bugs, both fixed the same day:
 * (1) outboxWorker.js's claimBatch never reclaimed an entry stuck in
 *     'processing' after a server restart — 84 entries had been silently
 *     orphaned for a week, their Sheets writes never happening. Fixed and
 *     drained live.
 * (2) 2 old 'expiry.sendExpiryToPending' entries died before that kind was
 *     registered in outboxRegistry.js — left as 'dead' rather than
 *     auto-replayed, since the container they reference was resubmitted
 *     with newer data since; replaying the stale action now would incorrectly
 *     undo that newer state.
 */
export function SyncStatusPage() {
  const { data, loading, error, reload } = useAsync(fetchSyncStatus, []);
  const counts = data?.counts || {};
  const entries = data?.entries || [];
  const needsAttention = (counts.failed || 0) + (counts.dead || 0) + (counts.processing || 0);

  return (
    <>
      <PageHeader
        title="Sync Status"
        subtitle="What's still pending replay to live Google Sheets after a Mongo-first write"
        actions={<Button variant="secondary" size="sm" onClick={reload}>Refresh</Button>}
      />
      <Card>
        {error && <ErrorState message={error} onRetry={reload} />}
        {!error && loading && <SkeletonTable columns={5} rows={8} />}
        {!error && !loading && (
          <>
            <div className={styles.counts}>
              <span className={styles.countItem}><strong>{counts.pending || 0}</strong> pending</span>
              <span className={styles.countItem}><strong>{counts.processing || 0}</strong> processing</span>
              <span className={styles.countItem}><strong>{counts.failed || 0}</strong> retrying</span>
              <span className={`${styles.countItem} ${counts.dead ? styles.countBad : ''}`}><strong>{counts.dead || 0}</strong> dead (gave up)</span>
              <span className={styles.countItem}><strong>{counts.done || 0}</strong> done</span>
            </div>

            {!entries.length
              ? <EmptyState message="Nothing pending — everything is synced to the Sheet." />
              : (
                <div className={styles.scrollWrap}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th>Action</th>
                        <th>Subject</th>
                        <th>Actor</th>
                        <th>Status</th>
                        <th>Attempts</th>
                        <th>Last Error</th>
                        <th>Created</th>
                      </tr>
                    </thead>
                    <tbody>
                      {entries.map((e) => (
                        <tr key={e.id}>
                          <td>{e.kind}</td>
                          <td>{e.subject || '—'}</td>
                          <td>{e.actor || '—'}</td>
                          <td className={styles[STATUS_TONE[e.status]] || ''}>{e.status}</td>
                          <td>{e.attempts}/{e.maxAttempts}</td>
                          <td className={styles.errCell}>{e.lastError || '—'}</td>
                          <td>{fmtWhen(e.createdAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

            {needsAttention > 0 && (
              <p className={styles.hint}>
                {counts.dead > 0 && `${counts.dead} entr${counts.dead === 1 ? 'y' : 'ies'} gave up after repeated failures and need manual review. `}
                {counts.failed > 0 && `${counts.failed} ${counts.failed === 1 ? 'is' : 'are'} still retrying automatically. `}
              </p>
            )}
          </>
        )}
      </Card>
    </>
  );
}
