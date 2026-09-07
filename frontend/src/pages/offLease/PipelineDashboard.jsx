import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { StatCard, Card, Button, SearchBar, ErrorState, EmptyState } from '../../components/ui/index.js';
import { SkeletonTable } from '../../components/ui/Skeleton.jsx';
import { useAsync } from '../../hooks/useAsync.js';
import { usePolling } from '../../hooks/usePolling.js';
import { useAutoRefresh } from '../../hooks/useAutoRefresh.js';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import { fetchOffLeaseDashboard } from '../../services/offLease.service.js';
import { fetchMyTasks } from '../../services/myTask.service.js';
import { STAGES } from '../../constants/stages.js';
import { ROUTES } from '../../constants/routes.js';
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
  const navigate = useNavigate();
  const { data, loading, error, reload } = useAsync(fetchOffLeaseDashboard, []);
  // Same background-eligibility catch as StagePageBase — see usePolling's doc comment.
  usePolling(() => reload({ silent: true }));
  useAutoRefresh('off-lease', () => reload({ silent: true }));
  /* Lease Expiry's own overdue count — same source the sidebar badge reads
     (getMyTasks -> .expired), fetched here too so the scorecard never shows
     a different number than the nav item right next to it. */
  const { data: taskCounts, loading: taskCountsLoading, reload: reloadTaskCounts } = useAsync(fetchMyTasks, []);
  usePolling(() => reloadTaskCounts({ silent: true }));
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
    else if (stageFilter === 'hold') out = out.filter((it) => it.onHold);
    else if (stageFilter === 'outstanding') out = out.filter((it) => it.hasOutstanding);
    else if (stageFilter === 'stage1Invoice') out = out.filter((it) => it.stageClass === 'stage1Invoice');
    /* pendingStages, not currentStageNum: a container can genuinely be
       pending in more than one stage's queue at once (see pendingStages'
       doc comment on the backend), and the KPI card's own count is a real
       queue length, not a count of items whose single currentStageNum
       happens to match. Filtering on currentStageNum alone let a card read
       "1" while its own click-through showed 0 records — the one container
       behind that count was pending here too, just not as its "primary"
       stage. */
    else if (stageFilter != null) out = out.filter((it) => it.pendingStages?.includes(stageFilter));

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
      : stageFilter === 'hold'
        ? 'On hold'
        : stageFilter === 'outstanding'
          ? 'Outstanding payment'
          : stageFilter === 'stage1Invoice'
            ? 'Stage 1.1 — Invoice'
            : stageFilter != null
              ? (STAGES.find((s) => s.number === stageFilter)?.label || `Stage ${stageFilter}`)
              : '';

  return (
    <>
      <div className={styles.kpiRow}>
        {/* Fixed order per explicit request, 2026-09-04: Lease Expiry, Hold,
            Active, then the live workflow in sequence (Intimation ->
            Approval -> Transportation -> Gate In -> Inspection -> Final
            Billing -> Outstanding Payment ["Payment Pending" in the user's
            own sequence, right after Billing]), Completed last. Stage 6
            (FMS Closure) is intentionally not in this row — everything else
            here is either a cross-module count or one explicit stage, not
            the generic STAGES.flatMap sweep this row used before. */}
        {/* Reverted to individual cards, 2026-09-04 — the combined split
            card read worse than two plain ones. Lease Expiry leads the row,
            navigating to that page (same destination the sidebar's own nav
            item goes to); Active Off-Lease keeps its own separate card. A
            plain client-side sum of the two — no backend change needed,
            both numbers are already loaded on this page. */}
        <StatCard
          icon="grid" label="Total · Lease Expiry + Off-Lease"
          value={(taskCounts?.expired != null && kpis.active != null) ? taskCounts.expired + kpis.active : '—'}
          loading={loading || taskCountsLoading}
          tint="neutral"
        />
        <StatCard
          icon="clock" label="Lease Expiry" value={taskCounts?.expired ?? '—'} loading={taskCountsLoading} tint="warn"
          footnote={taskCounts?.expired > 0 ? 'Overdue' : undefined}
          onClick={() => navigate(ROUTES.LEASE_EXPIRY)}
        />
        <StatCard
          icon="lock" label="Hold · Stage 1" value={kpis.holdStage1 ?? '—'} loading={loading} tint="warn"
          footnote={kpis.holdStage1 > 0 ? 'Paused' : undefined}
          onClick={() => toggleFilter('hold')}
        />
        <StatCard icon="package" label="Active off-lease requests" value={kpis.active ?? '—'} loading={loading} tint="navy" />
        <StatCard
          icon={STAGE_ICONS[1]} label="Stage 1 · Off-Lease Intimation" value={kpis.byStage?.[1] ?? '—'} loading={loading} tint="info"
          footnote={STAGES.find((s) => s.number === 1)?.owner}
          onClick={() => toggleFilter(1)}
        />
        <StatCard
          icon="edit" label="Stage 1.1 · Invoice" value={kpis.stage1Invoice ?? '—'} loading={loading} tint="warn"
          footnote={kpis.stage1Invoice > 0 ? 'Invoice pending' : undefined}
          onClick={() => toggleFilter('stage1Invoice')}
        />
        <StatCard
          icon="clock" label="Stage 1.2 · Approval" value={kpis.pendingApproval ?? '—'} loading={loading} tint="warn"
          footnote={kpis.pendingApproval > 0 ? 'Needs sign-off' : undefined}
          onClick={() => toggleFilter('approval')}
        />
        <StatCard
          icon={STAGE_ICONS[6]} label="Stage 2 · Transportation" value={kpis.byStage?.[6] ?? '—'} loading={loading} tint="info"
          footnote={STAGES.find((s) => s.number === 6)?.owner}
          onClick={() => toggleFilter(6)}
        />
        <StatCard
          icon={STAGE_ICONS[7]} label="Stage 3 · Gate In" value={kpis.byStage?.[7] ?? '—'} loading={loading} tint="info"
          footnote={STAGES.find((s) => s.number === 7)?.owner}
          onClick={() => toggleFilter(7)}
        />
        <StatCard
          icon={STAGE_ICONS[3]} label="Stage 4 · Inspection Checklist" value={kpis.byStage?.[3] ?? '—'} loading={loading} tint="info"
          footnote={STAGES.find((s) => s.number === 3)?.owner}
          onClick={() => toggleFilter(3)}
        />
        <StatCard
          icon={STAGE_ICONS[5]} label="Stage 5 · Final Billing" value={kpis.byStage?.[5] ?? '—'} loading={loading} tint="info"
          footnote={STAGES.find((s) => s.number === 5)?.owner}
          onClick={() => toggleFilter(5)}
        />
        {/* Moved to after Billing, 2026-09-04 — "Payment Pending" in the
            user's own stage sequence sits right after Billing, not before it. */}
        <StatCard
          icon="list" label="Outstanding Payment" value={kpis.outstandingCount ?? '—'} loading={loading} tint="warn"
          footnote={kpis.outstandingWithDamageCount > 0 ? `${kpis.outstandingWithDamageCount} with damage` : undefined}
          onClick={() => toggleFilter('outstanding')}
        />
        <StatCard icon="check" label="Completed this month" value={kpis.completedThisMonth ?? '—'} loading={loading} tint="success" />
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
            /* Refetches the dashboard after a stage form saves, so the
               chip that just went from current to done -- and the next one
               that becomes current -- update without a manual Refresh. */
            onStageSaved={reload}
            searching={!!search}
            /* No reload — the remark cell keeps itself up to date locally.
               Refetching all 35 records to reflect one comment is what made
               Save and Delete sit spinning. */
            onOpenRecord={setOpenRecord}
          />
        )}

        {view === 'table' && loading && <SkeletonTable columns={5} rows={8} />}
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
      <span key={`s${s.stage}`} className={dotClass(s.done, s.stage === currentStageNum)} title={`Stage ${s.displayStage ?? s.stage} · ${s.label}${s.skipped ? ' — Skipped' : s.done ? ' — Completed' : s.stage === currentStageNum ? ' — In progress' : ''}`}>
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
