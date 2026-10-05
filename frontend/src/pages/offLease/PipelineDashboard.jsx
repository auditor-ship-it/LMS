import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { StatCard, Card, Button, SearchBar, FilterBar, ErrorState, EmptyState } from '../../components/ui/index.js';
import { SkeletonTable } from '../../components/ui/Skeleton.jsx';
import { useAsync } from '../../hooks/useAsync.js';
import { usePolling } from '../../hooks/usePolling.js';
import { useAutoRefresh } from '../../hooks/useAutoRefresh.js';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import { fetchOffLeaseDashboard } from '../../services/offLease.service.js';
import { fetchMyTasks } from '../../services/myTask.service.js';
import { fetchRefunds } from '../../services/refunds.service.js';
import { usePermission } from '../../hooks/usePermission.js';
import { STAGES } from '../../constants/stages.js';
import { ROUTES } from '../../constants/routes.js';
import { toDate } from '../../utils/formatDateTime.js';
import { Highlight } from './Highlight.jsx';
import { OrderBookView } from './OrderBookView.jsx';
import styles from './PipelineDashboard.module.css';

const STAGE_ICONS = { 1: 'inbox', 2: 'container', 3: 'search', 4: 'edit', 5: 'list', 6: 'container', 7: 'check-circle', 8: 'lock', 11: 'inbox' };

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

/* Record fields the dashboard search looks through. */
const SEARCH_FIELDS = [
  'container', 'leaseId', 'clientName', 'clientCode', 'location', 'size', 'type',
  'raisedBy', 'deployedDate', 'validUpto', 'intimationDate'
];

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** "YYYY-MM" — sorts correctly as a plain string, which a "Month Year" label doesn't. */
const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

export function PipelineDashboard({ onOpenTab }) {
  const navigate = useNavigate();
  const { canAct } = usePermission();
  const { data, loading, error, reload } = useAsync(fetchOffLeaseDashboard, []);
  // Same background-eligibility catch as StagePageBase — see usePolling's doc comment.
  usePolling(() => reload({ silent: true }));
  useAutoRefresh('off-lease', () => reload({ silent: true }));
  /* Lease Expiry's own overdue count — same source the sidebar badge reads
     (getMyTasks -> .expired), fetched here too so the scorecard never shows
     a different number than the nav item right next to it. */
  const { data: taskCounts, loading: taskCountsLoading, reload: reloadTaskCounts } = useAsync(fetchMyTasks, []);
  usePolling(() => reloadTaskCounts({ silent: true }));
  /* Stage 6A (HOD) / Stage 6B (CEO) scorecards — explicit request 2026-10-05.
     SD Refunds is a separate backend system entirely (own sheet, own
     currentStage field — see refunds.service.js's own header comment), so
     this is its own fetch, not part of kpis.byStage above. Only fetched at
     all if the caller can act on at least one of the two, same gate the
     cards themselves use below. */
  const canSeeRefundApprovals = canAct('refundsApprovalHod') || canAct('refundsApprovalCeo');
  const { data: refundsData, reload: reloadRefunds } = useAsync(
    () => (canSeeRefundApprovals ? fetchRefunds() : Promise.resolve({ data: [] })),
    [canSeeRefundApprovals]
  );
  usePolling(() => reloadRefunds({ silent: true }));
  const refundRows = refundsData?.data || [];
  const hodPendingCount = refundRows.filter((r) => r.currentStage === 'hod').length;
  const ceoPendingCount = refundRows.filter((r) => r.currentStage === 'ceo').length;
  const [search, setSearch] = useState('');
  const [view, setView] = useState('book');
  // Opens the record's full stage history on its own page (not a modal).
  const openRecord = (rec) => {
    const q = new URLSearchParams({ container: rec.container });
    if (rec.leaseId) q.set('leaseId', rec.leaseId);
    if (rec._rowNum) q.set('row', String(rec._rowNum));
    navigate(`${ROUTES.OFF_LEASE_RECORD}?${q}`);
  };
  /* null = no filter; an internal stage number, 'approval' or 'done'. */
  const [stageFilter, setStageFilter] = useState(null);
  /* '' = every month; otherwise a "YYYY-MM" key (monthKey) — explicit request
     2026-09-23, grouped on `intimationDate` (Off-Lease Intimation Date — when
     the request was actually raised). BUG FOUND AND FIXED the same day: this
     first shipped grouped on "OL Date" instead, which is a forward-looking
     TARGET completion date entered on Stage 1's own form (same value as that
     record's own Final Billing Date) — a record raised in September could
     show up under "October" simply because that's the date someone typed as
     its target finish, which is what a live record confirmed. Intimation
     Date only ever moves forward in step with "when did this actually
     happen", never a planned future date. */
  const [monthFilter, setMonthFilter] = useState('');
  const debouncedSearch = useDebouncedValue(search, 200);

  const kpis = data?.kpis || {};
  const items = data?.items || [];

  /* Every month that actually has a record, newest first — built from the
     live data rather than hand-listed, so a new month appears on its own the
     moment the first record lands in it, and a record with a genuinely blank
     intimationDate is simply not offered as a filter (it can still be found
     via search/other filters, just not grouped into "no date" as if that
     were a real month). */
  const monthOptions = useMemo(() => {
    const seen = new Map(); // "YYYY-MM" -> label
    for (const it of items) {
      const d = toDate(it.intimationDate);
      if (!d) continue;
      const key = monthKey(d);
      if (!seen.has(key)) seen.set(key, `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`);
    }
    return [...seen.entries()]
      .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
      .map(([value, label]) => ({ value, label }));
  }, [items]);

  /* Clicking a KPI card filters this dashboard rather than jumping to that
     stage's tab. The cards describe THIS list, so sending the reader somewhere
     else to see what they just counted loses the context they were building. */
  const filtered = useMemo(() => {
    const term = debouncedSearch.trim().toLowerCase();
    let out = items;

    if (stageFilter === 'approval') out = out.filter((it) => it.stageClass === 'approval');
    else if (stageFilter === 'done') out = out.filter((it) => it.stageClass === 'done');
    else if (stageFilter === 'hold') out = out.filter((it) => it.onHold);
    /* pendingStages, not currentStageNum: a container can genuinely be
       pending in more than one stage's queue at once (see pendingStages'
       doc comment on the backend), and the KPI card's own count is a real
       queue length, not a count of items whose single currentStageNum
       happens to match. Filtering on currentStageNum alone let a card read
       "1" while its own click-through showed 0 records — the one container
       behind that count was pending here too, just not as its "primary"
       stage. */
    /* 6A / 6B: the records whose SD Refund is waiting on HOD / CEO. That status
       lives in the refunds sheet, not on the off-lease row, so match by
       container number — the same match the 6A/6B chips use. */
    else if (stageFilter === 'hod' || stageFilter === 'ceo') {
      const waiting = new Set(refundRows.filter((r) => r.currentStage === stageFilter).map((r) => String(r.containerNo || '').trim().toUpperCase()));
      out = out.filter((it) => waiting.has(String(it.container || '').trim().toUpperCase()));
    } else if (stageFilter != null) out = out.filter((it) => it.pendingStages?.includes(stageFilter));

    if (monthFilter) {
      out = out.filter((it) => {
        const d = toDate(it.intimationDate);
        return d && monthKey(d) === monthFilter;
      });
    }

    if (!term) return out;
    /* Every space-separated word must match somewhere in the record, in any
       order ("draeger vasai", "hnku 6063239", "reefer dahanu"). Matches the
       fields shown on the row, not just container / client / lease. */
    const words = term.split(/s+/).filter(Boolean);
    return out.filter((it) => {
      const hay = SEARCH_FIELDS.map((k) => String(it[k] ?? '')).join(' ').toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [items, debouncedSearch, stageFilter, monthFilter, refundRows]);

  /* Clicking the active card again clears it — the same control that applied
     the filter removes it, so there is no hunting for a reset. */
  const toggleFilter = (key) => setStageFilter((cur) => (cur === key ? null : key));
  const filterLabel = stageFilter === 'approval'
    ? 'Pending approval'
    : stageFilter === 'done'
      ? 'Completed'
      : stageFilter === 'hold'
        ? 'On hold'
        : stageFilter === 'hod'
          ? 'Stage 6A · HOD approval pending'
          : stageFilter === 'ceo'
            ? 'Stage 6B · CEO approval pending'
            : stageFilter != null
          ? (STAGES.find((s) => s.number === stageFilter)?.label || `Stage ${stageFilter}`)
          : '';

  return (
    <>
      <div className={styles.kpiPrimary}>
        {/* Fixed order per explicit request, 2026-09-04: Lease Expiry, Hold,
            Active, then the live workflow in sequence (Intimation ->
            Approval -> Transportation -> Gate In -> Inspection -> Final
            Billing), Completed last. Outstanding Payment card removed
            2026-09-29 (explicit request). Stage 6
            (KAM) is intentionally not in this row — everything else here is
            either a cross-module count or one explicit stage, not the
            generic STAGES.flatMap sweep this row used before. A real
            internal stage 10 ("LR & Return Transportation") lived here as
            "Stage 3" between Transportation and Gate In from 2026-09-18 to
            2026-09-22 (explicit request each time) — removed from the
            workflow entirely now, its KPI card gone with it, and every
            stage from Gate In onward shifted its display number back down
            by one. */}
        {/* Reverted to individual cards, 2026-09-04 — the combined split
            card read worse than two plain ones. Lease Expiry leads the row,
            navigating to that page (same destination the sidebar's own nav
            item goes to); Active Off-Lease keeps its own separate card. A
            plain client-side sum of the two — no backend change needed,
            both numbers are already loaded on this page. */}
        <StatCard size="lg"
          icon="grid" label="Total · Lease Expiry + Off-Lease"
          value={(taskCounts?.expired != null && kpis.active != null) ? taskCounts.expired + kpis.active : '—'}
          loading={loading || taskCountsLoading}
          tint="neutral"
        />
        <StatCard size="lg"
          icon="clock" label="Lease Expiry" value={taskCounts?.expired ?? '—'} loading={taskCountsLoading} tint="warn"
          footnote={taskCounts?.expired > 0 ? 'Overdue' : undefined}
          onClick={() => navigate(ROUTES.LEASE_EXPIRY)}
        />
        <StatCard size="lg" icon="package" label="Active off-lease requests" value={kpis.active ?? '—'} loading={loading} tint="navy" />
      </div>

      {/* One compact row for the per-stage counts; scrolls sideways rather
          than wrapping on a narrow window. */}
      <div className={styles.kpiStages}>
        <StatCard size="sm"
          icon="lock" label="Hold · Stage 1" value={kpis.holdStage1 ?? '—'} loading={loading} tint="hold"
          footnote={kpis.holdStage1 > 0 ? 'Paused' : undefined}
          active={stageFilter === 'hold'} onClick={() => toggleFilter('hold')}
        />
        <StatCard size="sm"
          icon={STAGE_ICONS[1]} label="Stage 1 · Off-Lease Intimation" value={kpis.byStage?.[1] ?? '—'} loading={loading} tint="info"
          footnote={STAGES.find((s) => s.number === 1)?.owner}
          active={stageFilter === 1} onClick={() => toggleFilter(1)}
        />
        <StatCard size="sm"
          icon="clock" label="Stage 1A · Approval" value={kpis.pendingApproval ?? '—'} loading={loading} tint="approval"
          footnote="Pushpalata"
          active={stageFilter === 'approval'} onClick={() => toggleFilter('approval')}
        />
        <StatCard size="sm"
          icon={STAGE_ICONS[6]} label="Stage 2 · Transportation" value={kpis.byStage?.[6] ?? '—'} loading={loading} tint="info"
          footnote={STAGES.find((s) => s.number === 6)?.owner}
          active={stageFilter === 6} onClick={() => toggleFilter(6)}
        />
        <StatCard size="sm"
          icon={STAGE_ICONS[7]} label="Stage 3 · Gate In" value={kpis.byStage?.[7] ?? '—'} loading={loading} tint="info"
          footnote={STAGES.find((s) => s.number === 7)?.owner}
          active={stageFilter === 7} onClick={() => toggleFilter(7)}
        />
        <StatCard size="sm"
          icon={STAGE_ICONS[3]} label="Stage 4 · Inspection Checklist" value={kpis.byStage?.[3] ?? '—'} loading={loading} tint="info"
          footnote={STAGES.find((s) => s.number === 3)?.owner}
          active={stageFilter === 3} onClick={() => toggleFilter(3)}
        />
        <StatCard size="sm"
          icon={STAGE_ICONS[5]} label="Stage 5 · Final Billing" value={kpis.byStage?.[5] ?? '—'} loading={loading} tint="info"
          footnote={STAGES.find((s) => s.number === 5)?.owner}
          active={stageFilter === 5} onClick={() => toggleFilter(5)}
        />
        {/* ADDED 2026-10-01 (explicit request: "add the stage 6 SD refunds")
            — internal stage 11, inserted before FMS Closed (internal 8,
            card just below, relabeled from "Stage 6" to "Stage 7" the same
            day). No footnote: no `owner` is set for this stage in stages.js
            (its status is set automatically, not by a named person). */}
        <StatCard size="sm"
          icon={STAGE_ICONS[11]} label="Stage 6 · SD Refunds" value={kpis.byStage?.[11] ?? '—'} loading={loading} tint="info"
          footnote="Christopher"
          active={stageFilter === 11} onClick={() => toggleFilter(11)}
        />
        {/* Stage 6A (HOD) / Stage 6B (CEO) — explicit request 2026-10-05.
            Jumps straight to the matching Off-Lease tab (onOpenTab, same
            mechanism the "Approve"/"Open" buttons in the table below already
            use) rather than this dashboard's own stageFilter/table, since
            SD Refunds records aren't part of that OL_SHEET-based table at
            all. Each card only renders for a caller who can act on that
            stage, same gate SdRefundApprovalTab itself falls back to a "no
            permission" message for — hiding the card entirely here is
            nicer than a dead-end click. */}
        {canAct('refundsApprovalHod') && (
          <StatCard size="sm"
            icon="clock" label="Stage 6A · HOD Approval" value={hodPendingCount} loading={loading} tint="approval"
            footnote="Pushpalata"
            active={stageFilter === 'hod'} onClick={() => toggleFilter('hod')}
          />
        )}
        {canAct('refundsApprovalCeo') && (
          <StatCard size="sm"
            icon="clock" label="Stage 6B · CEO Approval" value={ceoPendingCount} loading={loading} tint="approval"
            footnote="Akash Sir"
            active={stageFilter === 'ceo'} onClick={() => toggleFilter('ceo')}
          />
        )}
        {/* Explicit request 2026-09-29: replaces "Completed this month" —
            Stage 6 (FMS Closed, internal 8) was the one active stage with no
            card of its own on this dashboard at all; same pattern as every
            other Stage N card above (STAGE_ICONS[8]/byStage[8] already
            existed and were computed, just never rendered here). No footnote
            (unlike every other Stage N card): its `owner` (stages.js) was
            renamed 'Sales' -> 'FMS Closed' the same day, which would just
            repeat this card's own label.
            RELABELED 2026-10-01 "Stage 6" -> "Stage 7": SD Refunds (internal
            11, card just above) is now the display Stage 6.
            RELABELED AGAIN 2026-10-03 "FMS Closed" -> "Payment Status". */}
        <StatCard size="sm"
          icon={STAGE_ICONS[8]} label="Stage 7 · Payment Status" value={kpis.byStage?.[8] ?? '—'} loading={loading} tint="info"
          footnote="FMS Done"
          active={stageFilter === 8} onClick={() => toggleFilter(8)}
        />
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
          {/* Month grouped with Search in their own row so they always sit
              side by side — explicit request 2026-09-23: the toolbar's own
              space-between wrap previously let Month isolate onto its own
              line above Search instead of sitting next to it. */}
          <div className={styles.searchRow}>
            <FilterBar
              filters={[{
                key: 'month',
                label: 'Month',
                value: monthFilter,
                onChange: setMonthFilter,
                options: monthOptions
              }]}
            />
            <SearchBar variant="large" value={search} onChange={setSearch} placeholder="Search container, client, lease, location…" />
          </div>
          {/* An active filter has to be visible and removable here — otherwise
              a shrunken list looks like missing data. */}
          {stageFilter != null && (
            <button type="button" className={styles.filterChip} onClick={() => setStageFilter(null)} title="Clear filter">
              <span className={styles.filterKicker}>Filtered by</span>
              <span className={styles.filterName}>{filterLabel}</span>
              <span className={styles.filterX} aria-hidden="true">×</span>
              <span className={styles.srOnly}>Clear filter</span>
            </button>
          )}
          <span className={styles.count}>{filtered.length} record{filtered.length === 1 ? '' : 's'}</span>
        </div>

        {view === 'book' && (
          <OrderBookView
            highlight={debouncedSearch}
            items={filtered}
            loading={loading}
            error={error}
            onRetry={reload}
            onOpenTab={onOpenTab}
            refundRows={refundRows}
            /* Refetches the dashboard after a stage form saves, so the
               chip that just went from current to done -- and the next one
               that becomes current -- update without a manual Refresh. */
            onStageSaved={reload}
            searching={!!search}
            /* No reload — the remark cell keeps itself up to date locally.
               Refetching all 35 records to reflect one comment is what made
               Save and Delete sit spinning. */
            onOpenRecord={openRecord}
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
                    <td className={styles.leaseId}><Highlight text={it.leaseId || '—'} query={debouncedSearch} /></td>
                    <td className={styles.container}><Highlight text={it.container} query={debouncedSearch} /></td>
                    <td><Highlight text={it.clientName || '—'} query={debouncedSearch} /></td>
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
