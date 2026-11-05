import { useMemo, useState } from 'react';
import { PageHeader, Card, LoadingState, ErrorState, SearchBar, Pagination } from '../../components/ui/index.js';
import { useAsync } from '../../hooks/useAsync.js';
import { usePagination } from '../../hooks/usePagination.js';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import { useAutoRefresh } from '../../hooks/useAutoRefresh.js';
import { getOffLeaseTatReport } from '../../api/offlease.api.js';
import { formatActionTimestamp } from '../../utils/formatDateTime.js';
import styles from './OffLeaseTatPage.module.css';

const STATUS_CLASS = {
  Completed: styles.statusCompleted,
  Delayed: styles.statusDelayed,
  'In Progress': styles.statusInProgress,
  Pending: styles.statusPending,
  Skipped: styles.statusSkipped
};

/**
 * TAT Tracking — explicit spec 2026-11-04 ("Offlease New TAT (Turnaround
 * Time) Tracking System"): every Off-Lease record's own Entry/Planned/
 * Actual/Delay breakdown across all 11 stages (1, 1A, 2, 3, 4, 5, 6, 6A, 6B,
 * 6C, 7). Backed by GET /offlease/tat-report
 * (offLeaseTatTracking.service.js's getOffLeaseTatReport) — a dedicated
 * engine, separate from the two narrower SLA/TAT systems already in this
 * app (offleaseSla.service.js's Container-History SLA column,
 * offlease.service.js's per-stage-queue TAT column) — see that service
 * file's own header comment for why.
 *
 * One record per Off-Lease Tracking row (a container can legitimately have
 * more than one — a re-lease to a different client — so the list is keyed
 * by container+Lease ID, never container alone). Collapsed by default (101+
 * records x 11 stages would be a lot to render open at once); click a row
 * to expand its full stage table, same STAGE/STATUS/ENTRY/PLANNED/ACTUAL/
 * DELAY shape as the Container History table elsewhere in Off-Lease,
 * explicit request the same day ("pls add the kab stage mai aaya kab form
 * filled kiya kitna dely hua aur kitna jaldi yah table pe show hoga").
 */
export function OffLeaseTatPage() {
  const { data, loading, error, reload } = useAsync(() => getOffLeaseTatReport(), []);
  useAutoRefresh('off-lease', () => reload({ silent: true }));

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 250);
  const [expanded, setExpanded] = useState(() => new Set());

  const records = data?.records || [];

  const filtered = useMemo(() => {
    const term = debouncedSearch.trim().toLowerCase();
    if (!term) return records;
    return records.filter((r) =>
      String(r.containerNo || '').toLowerCase().includes(term) ||
      String(r.leaseId || '').toLowerCase().includes(term) ||
      String(r.clientName || '').toLowerCase().includes(term));
  }, [records, debouncedSearch]);

  const { page, totalPages, pageRows, setPage, nextPage, prevPage, resetPage } = usePagination(filtered, 15);

  const toggle = (key) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const totalDelayedStages = filtered.reduce((n, r) => n + (r.overdueStageCount || 0), 0);
  const totalDelayedRecords = filtered.filter((r) => r.overdueStageCount > 0).length;

  return (
    <>
      <PageHeader
        title="TAT Tracking"
        subtitle="Entry, Planned, Actual and Delay for every stage (1, 1A, 2, 3, 4, 5, 6, 6A, 6B, 6C, 7)"
      />

      <div className={styles.toolbar}>
        <SearchBar
          value={search}
          onChange={(v) => { setSearch(v); resetPage(); }}
          placeholder="Search container, lease ID, client…"
        />
        <span className={styles.summary}>
          {filtered.length} record{filtered.length === 1 ? '' : 's'}
          {totalDelayedRecords > 0 && <> · <strong className={styles.summaryDelayed}>{totalDelayedRecords} with delayed stages ({totalDelayedStages} total)</strong></>}
        </span>
      </div>

      {loading && <LoadingState />}
      {!loading && error && <ErrorState message={error} onRetry={reload} />}

      {!loading && !error && (
        <>
          {pageRows.map((r) => {
            const key = `${r.containerNo}|${r.leaseId}`;
            const isOpen = expanded.has(key);
            return (
              <Card key={key} className={styles.recordCard}>
                <button type="button" className={styles.recordHeader} onClick={() => toggle(key)}>
                  <span className={styles.chevron}>{isOpen ? '▾' : '▸'}</span>
                  <span className={styles.container}>{r.containerNo}</span>
                  {r.leaseId && <span className={styles.leaseTag}>{r.leaseId}</span>}
                  <span className={styles.client}>{r.clientName}</span>
                  <span className={styles.spacer} />
                  <span className={styles.metaItem}>Planned {r.plannedTotalLabel || '—'}</span>
                  <span className={styles.metaItem}>Actual {r.actualTotalLabel || '—'}</span>
                  {r.overdueStageCount > 0 && (
                    <span className={styles.overdueBadge}>{r.overdueStageCount} Delayed</span>
                  )}
                </button>
                {isOpen && (
                  <div className={styles.tableWrap}>
                    <table className={styles.stageTable}>
                      <thead>
                        <tr>
                          <th>Stage</th>
                          <th>TAT</th>
                          <th>Status</th>
                          <th>Entered Stage</th>
                          <th>Planned Completion</th>
                          <th>Actual Completion</th>
                          <th>Delay / Early</th>
                          <th>By</th>
                        </tr>
                      </thead>
                      <tbody>
                        {r.stages.map((s) => (
                          <tr key={s.key} className={s.status === 'Delayed' ? styles.rowDelayed : undefined}>
                            <td className={styles.stageCell}><strong>{s.key}</strong> {s.label}</td>
                            <td className={styles.muted}>{s.budgetLabel || 'no budget'}</td>
                            <td><span className={`${styles.statusPill} ${STATUS_CLASS[s.status] || ''}`}>{s.status}</span></td>
                            <td>{s.entryAt ? formatActionTimestamp(s.entryAt) : '—'}</td>
                            <td>{s.plannedAt ? formatActionTimestamp(s.plannedAt) : '—'}</td>
                            <td>{s.actualAt ? formatActionTimestamp(s.actualAt) : '—'}</td>
                            <td className={s.status === 'Delayed' ? styles.delayText : undefined}>{s.delayLabel || '—'}</td>
                            <td>{s.by || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            );
          })}
          {!filtered.length && <Card className={styles.emptyCard}>No Off-Lease records match this search.</Card>}
          <Pagination page={page} totalPages={totalPages} onPrev={prevPage} onNext={nextPage} onPage={setPage} />
        </>
      )}
    </>
  );
}
