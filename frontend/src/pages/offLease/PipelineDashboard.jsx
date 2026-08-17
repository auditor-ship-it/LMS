import { useMemo, useState } from 'react';
import { StatCard, Card, Button, SearchBar, LoadingState, ErrorState, EmptyState } from '../../components/ui/index.js';
import { useAsync } from '../../hooks/useAsync.js';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import { fetchOffLeaseDashboard } from '../../services/offLease.service.js';
import { STAGES } from '../../constants/stages.js';
import { OrderBookView } from './OrderBookView.jsx';
import { ContainerDetailModal } from './ContainerDetailModal.jsx';
import styles from './PipelineDashboard.module.css';

const STAGE_ICONS = { 1: 'inbox', 2: 'container', 3: 'search', 4: 'edit', 5: 'list', 6: 'container', 7: 'check-circle', 8: 'lock' };

/**
 * Off-Lease pipeline overview — KPI counts + every active container's
 * current stage in one table, mirroring the "Pending Approval"/"Stage N"
 * tabs' data (GET /offlease/dashboard, offlease.service.js's
 * getOffLeaseDashboardData) rather than duplicating any write logic here.
 * Clicking "Open"/"Approve" jumps to the tab that actually owns the action —
 * this page is a map of where things are, not a new place to act on them.
 */
/* Two presentations of the SAME /offlease/dashboard response — View 1 reads
   like an order book (one block per record, pipeline as a chip strip), View 2
   is the compact table. Neither refetches when you switch; the choice is
   presentation only. */
const VIEWS = [
  { key: 'book', label: 'View 1' },
  { key: 'table', label: 'View 2' }
];

export function PipelineDashboard({ onOpenTab }) {
  const { data, loading, error, reload } = useAsync(fetchOffLeaseDashboard, []);
  const [search, setSearch] = useState('');
  const [view, setView] = useState('book');
  // The record whose full stage history is open, or null.
  const [openRecord, setOpenRecord] = useState(null);
  /* null = no filter; an internal stage number, 'approval' or 'done'. */
  const [stageFilter, setStageFilter] = useState(null);
  const debouncedSearch = useDebouncedValue(search, 200);

  const kpis = data?.kpis || {};
  const items = data?.items || [];

  /* Clicking a KPI card filters this dashboard rather than jumping to that
     stage's tab. The cards describe THIS list, so sending the reader somewhere
     else to see what they just counted loses the context they were building. */
  const filtered = useMemo(() => {
    const term = debouncedSearch.trim().toLowerCase();
    let out = items;

    if (stageFilter === 'approval') out = out.filter((it) => it.stageClass === 'approval');
    else if (stageFilter === 'done') out = out.filter((it) => it.stageClass === 'done');
    else if (stageFilter != null) out = out.filter((it) => it.currentStageNum === stageFilter);

    if (!term) return out;
    return out.filter((it) =>
      it.container.toLowerCase().includes(term) ||
      it.clientName.toLowerCase().includes(term) ||
      it.leaseId.toLowerCase().includes(term));
  }, [items, debouncedSearch, stageFilter]);

  /* Clicking the active card again clears it — the same control that applied
     the filter removes it, so there is no hunting for a reset. */
  const toggleFilter = (key) => setStageFilter((cur) => (cur === key ? null : key));
  const filterLabel = stageFilter === 'approval'
    ? 'Pending approval'
    : stageFilter === 'done'
      ? 'Completed'
      : stageFilter != null
        ? (STAGES.find((s) => s.number === stageFilter)?.label || `Stage ${stageFilter}`)
        : '';

  return (
    <>
      <div className={styles.kpiRow}>
        <StatCard icon="package" label="Active off-lease requests" value={kpis.active ?? '—'} tint="navy" />
        <StatCard
          icon="clock" label="Pending approval" value={kpis.pendingApproval ?? '—'} tint="warn"
          footnote={kpis.pendingApproval > 0 ? 'Needs sign-off' : undefined}
          onClick={() => toggleFilter('approval')}
        />
        {STAGES.map((s) => (
          <StatCard
            key={s.number}
            icon={STAGE_ICONS[s.number]}
            label={`Stage ${s.display} · ${s.label}`}
            value={kpis.byStage?.[s.number] ?? '—'}
            tint={s.number === 8 ? 'success' : 'info'}
            footnote={s.owner}
            onClick={() => toggleFilter(s.number)}
          />
        ))}
        <StatCard icon="check" label="Completed this month" value={kpis.completedThisMonth ?? '—'} tint="success" />
      </div>

      <Card
        title="Active off-lease pipeline"
        actions={
          <>
            <div className={styles.viewRow}>
              {VIEWS.map((v) => (
                <button
                  key={v.key}
                  type="button"
                  className={`${styles.viewTab} ${view === v.key ? styles.viewTabActive : ''}`}
                  onClick={() => setView(v.key)}
                >
                  {v.label}
                </button>
              ))}
            </div>
            <Button variant="secondary" size="sm" onClick={reload}>Refresh</Button>
          </>
        }
      >
        <div className={styles.toolbar}>
          <SearchBar value={search} onChange={setSearch} placeholder="Search container, client, lease ID…" />
          {/* An active filter has to be visible and removable here — otherwise
              a shrunken list looks like missing data. */}
          {stageFilter != null && (
            <button type="button" className={styles.filterChip} onClick={() => setStageFilter(null)}>
              {filterLabel}
              <span className={styles.filterX} aria-hidden="true">×</span>
              <span className={styles.srOnly}>Clear filter</span>
            </button>
          )}
          <span className={styles.count}>{filtered.length} record{filtered.length === 1 ? '' : 's'}</span>
        </div>

        {view === 'book' && (
          <OrderBookView
            items={filtered}
            loading={loading}
            error={error}
            onRetry={reload}
            onOpenTab={onOpenTab}
            searching={!!search}
            /* No reload — the remark cell keeps itself up to date locally.
               Refetching all 35 records to reflect one comment is what made
               Save and Delete sit spinning. */
            onOpenRecord={setOpenRecord}
          />
        )}

        {view === 'table' && loading && <LoadingState label="Loading pipeline…" />}
        {view === 'table' && !loading && error && <ErrorState message={error} onRetry={reload} />}
        {view === 'table' && !loading && !error && filtered.length === 0 && (
          <EmptyState message="No active off-lease containers" hint={search ? 'Try a different search' : undefined} />
        )}

        {view === 'table' && !loading && !error && filtered.length > 0 && (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Lease ID</th>
                  <th>Container</th>
                  <th>Client</th>
                  <th>Stage</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {/* Container alone is not unique — one container can be
                    off-leased under two leases (TRIU6681671), which React
                    reported as a duplicate key and could collapse into one
                    row. The lease is what distinguishes the records. */}
                {filtered.map((it, i) => (
                  <tr key={`${it.leaseId || i}-${it.container}`}>
                    <td className={styles.leaseId}>{it.leaseId || '—'}</td>
                    <td className={styles.container}>{it.container}</td>
                    <td>{it.clientName || '—'}</td>
                    <td><MiniPipeline item={it} /></td>
                    <td className={styles.actionCell}>
                      {it.stageClass === 'approval' ? (
                        <Button size="sm" variant="primary" onClick={() => onOpenTab?.('approval')}>Approve</Button>
                      ) : it.stageClass === 'done' ? (
                        <span className={styles.doneTag}>Released</span>
                      ) : it.stageClass === 'rejected' ? (
                        <span className={styles.rejectedTag}>Rejected</span>
                      ) : (
                        <Button size="sm" variant="secondary" onClick={() => onOpenTab?.(`stage${it.currentStageNum}`)}>Open</Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {openRecord && (
        <ContainerDetailModal
          container={openRecord.container}
          leaseId={openRecord.leaseId}
          onClose={() => setOpenRecord(null)}
        />
      )}
    </>
  );
}

/**
 * A real connected step-tracker: a numbered dot per stage (1-8, + the
 * approval gate "A" between Stage 1 and 2), joined by a line that fills in
 * behind everything already done. Numbers stay inside the dot so the row
 * stays single-line (matches every other DataGrid in this app) — full stage
 * name is still available via title="" on hover.
 */
function MiniPipeline({ item }) {
  const { stages, approvalStatus, currentStageNum, stageClass } = item;
  const approvalLower = String(approvalStatus || '').trim().toLowerCase();

  const dotClass = (done, isCurrent, rejected) => [
    styles.dot,
    rejected ? styles.dotRejected : done ? styles.dotDone : isCurrent ? styles.dotCurrent : styles.dotFuture
  ].filter(Boolean).join(' ');

  const lineClass = (filled) => [styles.line, filled ? styles.lineDone : ''].filter(Boolean).join(' ');

  const nodes = [];
  stages.forEach((s, i) => {
    if (i !== 0) nodes.push(<span key={`l${s.stage}`} className={lineClass(stages[i - 1].done)} />);
    nodes.push(
      // displayStage, not stage — the dot shows the user-facing number.
      <span key={`s${s.stage}`} className={dotClass(s.done, s.stage === currentStageNum)} title={`Stage ${s.displayStage ?? s.stage} · ${s.label}${s.done ? ' — Completed' : s.stage === currentStageNum ? ' — In progress' : ''}`}>
        {s.displayStage ?? s.stage}
      </span>
    );
    if (i === 0) {
      const gateDone = approvalLower === 'approved';
      const gateRejected = approvalLower === 'rejected';
      nodes.push(<span key="gl" className={lineClass(gateDone)} />);
      nodes.push(
        <span
          key="gate"
          className={dotClass(gateDone, stageClass === 'approval', gateRejected)}
          title={`Intimation Approval — ${gateRejected ? 'Rejected' : gateDone ? 'Approved' : 'Pending'}`}
        >
          A
        </span>
      );
    }
  });

  return <div className={styles.pipeline}>{nodes}</div>;
}
