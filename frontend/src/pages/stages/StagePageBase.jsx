import { useMemo, useState } from 'react';
import { PageHeader } from '../../components/ui/PageHeader.jsx';
import { Card } from '../../components/ui/Card.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { SearchBar } from '../../components/ui/SearchBar.jsx';
import { FilterBar } from '../../components/ui/FilterBar.jsx';
import { Pagination } from '../../components/ui/Pagination.jsx';
import { DataGrid } from '../../components/ui/DataGrid.jsx';
import { StatusBadge } from '../../components/ui/StatusBadge.jsx';
import { renderCellValue } from '../../components/ui/CellValue.jsx';
import { ALL_STAGES, stageDisplayNumber, stageCaption, isReadOnlyStage } from '../../constants/stages.js';
import { formatActionTimestamp } from '../../utils/formatDateTime.js';
import { useAsync } from '../../hooks/useAsync.js';
import { usePolling } from '../../hooks/usePolling.js';
import { usePagination } from '../../hooks/usePagination.js';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import { usePermission } from '../../hooks/usePermission.js';
import { fetchStageList, submitHold, submitSendBackToStage1, submitSendRejectedToStage1 } from '../../services/stage.service.js';
import { isRateOrAmountHeader } from '../../utils/isRateOrAmountHeader.js';
import { apiErrorMessage } from '../../shared/auth/index.js';
import { StageDetailModal } from './StageDetailModal.jsx';
import { HoldModal } from './HoldModal.jsx';
import styles from './StagePageBase.module.css';

/* Only Stage 1 (Intimation) gets the Hold and Reject sub-tabs today — Hold
   is a per-record "park this without processing it yet" toggle (same row,
   no duplicate, see saveOffLeaseHold's doc comment); Reject mirrors a
   rejected Stage 1A/Approval decision back into Stage 1's own page (see
   saveOffLeaseSendRejectedToStage1's doc comment). A plain number check
   rather than a Set/config list since nothing else has asked for either;
   if a second stage ever needs them, promote this to a stages.js-level set
   the same way READ_ONLY_STAGES already works. */
const STAGE1_EXTRAS_STAGE = 1;

/* Stage 2 (internal 6, Transportation) only — the list is big enough here
   (dozens of pending records across many clients/depots) that Location and
   Size filters are worth it; no other stage's queue has asked for them.
   A plain number check, same reasoning as STAGE1_EXTRAS_STAGE above. */
const LOCATION_FILTER_STAGE = 6;

/* Size (col_2) and Type (col_3) are both messy free text — "40 FT Reefer
   Refurbished - RFH40R", "20FT Cabin", "Reefer Container" — so the filter
   classifies by substring rather than exact match. Cabin is checked first:
   "20FT Cabin" contains both "20" and "cabin", and belongs under Site Cabin,
   not 20FT. */
function classifySize(sizeCell, typeCell) {
  const s = String(sizeCell || '').toLowerCase();
  const t = String(typeCell || '').toLowerCase();
  if (t === 'site cabin' || s.includes('cabin')) return 'Site Cabin';
  if (s.includes('20')) return '20FT';
  if (s.includes('40')) return '40FT';
  return null;
}
const SIZE_FILTER_OPTIONS = [
  { value: '40FT', label: '40FT' },
  { value: '20FT', label: '20FT' },
  { value: 'Site Cabin', label: 'Site Cabin' }
];

/**
 * Shared, fully-working shell for Off-Lease Stage 1..8 pages — one component
 * parametrized by stageNumber. Lists the rows currently pending at this
 * stage, and opens StageDetailModal (backed by stageFields.js) to view/edit
 * this stage's specific fields for a row.
 */
/** undefined = sheet unreadable, null = read but no row, object = found. */
const dotState = (v) => (v === undefined ? 'unread' : v ? 'found' : 'missing');
const DOT_TITLE = { found: 'record found', missing: 'no record', unread: 'sheet unavailable' };

/** The FMS chain (STAGE-8 Movement -> STAGE-9 Transport -> STAGE-10 Site
 *  Delivery) as an actual connected pipeline — three nodes joined by lines,
 *  same visual language as PipelineDashboard.jsx's own MiniPipeline step-
 *  tracker (offLease/PipelineDashboard.module.css's .dot/.line), not three
 *  disconnected badges. A line fills in once the step BEFORE it is found,
 *  reading left-to-right as "how far the physical movement has actually
 *  progressed" the same way MiniPipeline reads "how far the workflow has
 *  progressed". Full detail is still behind View — this is the at-a-glance
 *  column, not the full record. */
function FmsDots({ item }) {
  const steps = [
    [8, 'Movement', item?.movement],
    [9, 'Transport', item?.transport],
    [10, 'Site Delivery', item?.delivery]
  ];
  return (
    <span className={styles.dots}>
      {steps.map(([n, label, value], i) => {
        const state = dotState(value);
        return (
          <span key={n} className={styles.dotWrap}>
            {i > 0 && <span className={`${styles.dotLine} ${dotState(steps[i - 1][2]) === 'found' ? styles.dotLineDone : ''}`} />}
            <span
              className={`${styles.dot} ${styles[`dot_${state}`]}`}
              title={`Stage ${n} — ${label}: ${DOT_TITLE[state]}`}
            >
              {n}
            </span>
          </span>
        );
      })}
    </span>
  );
}

export function StagePageBase({ stageNumber, embedded }) {
  // ALL_STAGES, not STAGES: a retired stage's direct route still has to label
  // itself correctly for anyone opening historical data.
  const stage = ALL_STAGES.find((s) => s.number === stageNumber);
  const displayNumber = stageDisplayNumber(stageNumber);
  const permKey = `offlease${stageNumber}`;
  const { canAct } = usePermission();
  /* A read-only stage is never editable, whatever the permission says — it has
     no form to open, so the Open button and the detail modal are both gone. */
  const readOnly = isReadOnlyStage(stageNumber);
  const canEdit = !readOnly && canAct(permKey);
  const stage1Extras = stageNumber === STAGE1_EXTRAS_STAGE;

  /* 'pending' (the normal queue), 'hold' or 'reject' (Stage 1's own Hold /
     Reject views) — only ever switched away from 'pending' when
     stage1Extras, but harmless to carry for every stage since
     fetchStageList ignores it unless the backend also recognises
     stageNumber === 1. */
  const [subTab, setSubTab] = useState('pending');
  const { data, loading, error, reload } = useAsync(
    () => fetchStageList(stageNumber, stage1Extras && subTab !== 'pending' ? subTab : undefined),
    [stageNumber, stage1Extras, subTab]
  );
  /* Catches a container becoming eligible from OUTSIDE this app — a Gate-In
     form submission, an FMS sheet update — without the user clicking
     Refresh. Those land in the 5-minute cache the backend already refreshes
     on its own cron; this just re-reads it more often than "next page
     load" so the tab reflects it within a minute instead of whenever
     someone happens to navigate back here. */
  usePolling(() => reload({ silent: true }));
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search);
  const [locationFilter, setLocationFilter] = useState('');
  const [sizeFilter, setSizeFilter] = useState('');
  const [activeRow, setActiveRow] = useState(null);
  const [busyKey, setBusyKey] = useState('');
  const [actionError, setActionError] = useState('');
  /* Hold asks for an optional Remarks/Comment first (HoldModal) rather than
     holding instantly on click — holdTarget is the row the modal is open
     for, null when closed. */
  const [holdTarget, setHoldTarget] = useState(null);
  const [holdBusy, setHoldBusy] = useState(false);
  const [holdError, setHoldError] = useState('');

  const switchSubTab = (key) => { setSubTab(key); setSearch(''); resetPage(); };

  const handleHoldSubmit = async (remarks) => {
    const containerNo = holdTarget?.row?.[0];
    setHoldBusy(true);
    setHoldError('');
    try {
      const result = await submitHold(containerNo, remarks, holdTarget?._rowNum);
      if (result === 'ALREADY_PROCESSED') {
        setActionError(`${containerNo} was already put on hold by someone else.`);
      }
      setHoldTarget(null);
      await reload();
    } catch (e) {
      setHoldError(apiErrorMessage(e));
    } finally {
      setHoldBusy(false);
    }
  };

  const handleSendBackToStage1 = async (item) => {
    const containerNo = item.row?.[0];
    setBusyKey(containerNo);
    setActionError('');
    try {
      await submitSendBackToStage1(containerNo, item._rowNum);
      await reload();
    } catch (e) {
      setActionError(apiErrorMessage(e));
    } finally {
      setBusyKey('');
    }
  };

  const handleSendRejectedToStage1 = async (item) => {
    const containerNo = item.row?.[0];
    setBusyKey(containerNo);
    setActionError('');
    try {
      await submitSendRejectedToStage1(containerNo, item._rowNum);
      await reload();
    } catch (e) {
      setActionError(apiErrorMessage(e));
    } finally {
      setBusyKey('');
    }
  };

  const headers = data?.headers || [];
  const rows = data?.data || [];

  const visibleIdx = useMemo(
    () => headers.map((_, i) => i).filter((i) => !isRateOrAmountHeader(headers[i])),
    [headers]
  );
  const visibleHeaders = useMemo(() => visibleIdx.map((i) => headers[i]), [visibleIdx, headers]);

  /* r.row is NOT the raw sheet row — getOffLeaseData compacts it to just the
     display columns (displayIndices = [0,1,2,3,5,6,7,8,9], Client Code at
     raw col_4 dropped), so position 5 here is Location (raw col_6), not 6 —
     index 6 in this array is Deployed Date, which is exactly what showed up
     in the filter the first time this was wired to the raw column number.
     All distinct values actually present in THIS stage's rows, not a fixed
     list, so a new depot city shows up here the moment a row exists for it. */
  const locationOptions = useMemo(() => {
    if (stageNumber !== LOCATION_FILTER_STAGE) return [];
    const set = new Set();
    for (const r of rows) {
      const loc = String(r.row?.[5] || '').trim();
      if (loc) set.add(loc);
    }
    return [...set].sort((a, b) => a.localeCompare(b)).map((v) => ({ value: v, label: v }));
  }, [rows, stageNumber]);

  const filteredRows = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    return rows.filter((r) => {
      if (q && !(r.row || []).some((cell) => String(cell ?? '').toLowerCase().includes(q))) return false;
      if (locationFilter && String(r.row?.[5] || '').trim() !== locationFilter) return false;
      if (sizeFilter && classifySize(r.row?.[2], r.row?.[3]) !== sizeFilter) return false;
      return true;
    });
  }, [rows, debouncedSearch, locationFilter, sizeFilter]);

  const { page, totalPages, pageRows, setPage, nextPage, prevPage, resetPage } = usePagination(filteredRows, 10);

  return (
    <>
      {!embedded && (
        <PageHeader
          title={displayNumber ? `Stage ${displayNumber}` : (stage?.label || '')}
          subtitle={displayNumber ? (stage?.label || '') : 'Retired stage — historical records only'}
        />
      )}
      <Card>
        {/* Stage 1 only: Pending / Hold / Reject — a held or rejected record
            drops out of the normal queue and appears here instead, same
            row, no duplicate. See saveOffLeaseHold's and
            saveOffLeaseSendRejectedToStage1's doc comments on the backend. */}
        {stage1Extras && (
          <div className={styles.tabRow}>
            <button
              type="button"
              className={`${styles.tab} ${subTab === 'pending' ? styles.tabActive : ''}`}
              onClick={() => switchSubTab('pending')}
            >
              Pending
            </button>
            <button
              type="button"
              className={`${styles.tab} ${subTab === 'hold' ? styles.tabActive : ''}`}
              onClick={() => switchSubTab('hold')}
            >
              Hold
            </button>
            <button
              type="button"
              className={`${styles.tab} ${subTab === 'reject' ? styles.tabActive : ''}`}
              onClick={() => switchSubTab('reject')}
            >
              Reject
            </button>
          </div>
        )}

        <div className={styles.toolbar}>
          <SearchBar value={search} onChange={setSearch} placeholder="Search by container, lease ID, client…" />
          <span className={styles.count}>
            {filteredRows.length} {stage1Extras && subTab !== 'pending' ? subTab : 'pending'} record{filteredRows.length === 1 ? '' : 's'}
          </span>
        </div>

        {stageNumber === LOCATION_FILTER_STAGE && (
          <div className={styles.stageFilterBar}>
            <FilterBar
              filters={[
                { key: 'location', label: 'Location', options: locationOptions, value: locationFilter, onChange: setLocationFilter },
                { key: 'size', label: 'Size', options: SIZE_FILTER_OPTIONS, value: sizeFilter, onChange: setSizeFilter }
              ]}
            />
          </div>
        )}

        {actionError && <p className={styles.actionError}>{actionError}</p>}

        <DataGrid
          headers={[
            ...visibleHeaders,
            /* The remark captured in the Hold/Reject dialog — only
               meaningful, and only ever shown, on that same Stage 1 sub-tab. */
            ...(stage1Extras && subTab === 'hold' ? ['Hold Remarks'] : []),
            ...(stage1Extras && subTab === 'reject' ? ['Reject Remarks'] : []),
            ...(readOnly ? ['Status'] : []),
            /* Budget in the header, so every cell below reads as "elapsed"
               without repeating "of 1h" on every row. */
            ...(data?.tatBudget ? [`TAT (${data.tatBudget})`] : [])
          ]}
          rows={pageRows}
          loading={loading}
          error={error}
          onRetry={reload}
          emptyMessage={
            stage1Extras && subTab === 'hold'
              ? 'No records on hold'
              : stage1Extras && subTab === 'reject'
              ? 'No rejected records'
              : `No pending records for ${stageCaption(stageNumber)}`
          }
          rowKey={(r) => r._rowNum}
          renderRow={(values, item) => [
            ...visibleIdx.map((i) => <td key={i}>{renderCellValue(values[i] ?? '')}</td>),
            ...(stage1Extras && subTab === 'hold'
              ? [<td key="holdRemarks">{item?.holdRemarks || '—'}</td>]
              : []),
            ...(stage1Extras && subTab === 'reject'
              ? [<td key="rejectRemarks">{item?.rejectRemarks || '—'}</td>]
              : []),
            /* Status here is the FMS pipeline, not this stage's own status —
               every row in this list is pending at this stage by definition
               (that is what puts it in the queue), so "Pending" said nothing.
               What a reader wants to know is how far the container has got
               through STAGE-8 -> 9 -> 10. */
            ...(readOnly ? [<td key="status"><FmsDots item={item} /></td>] : []),
            ...(data?.tatBudget
              ? [<td key="tat">{item?.tat
                ? item.tat.completed
                  ? (
                    /* Stage 2 (Transportation) once STAGE-8 + STAGE-9 have
                       both matched — the clock is frozen, not still running,
                       so this reads "Completed", never "over". A backdated
                       row (the FMS movement/transport was recorded months
                       before this app's own Stage 2 entry — physical
                       transport happening ahead of the paperwork) has no real
                       elapsed time to show, so it says so plainly instead of
                       a bare "0m" that reads like a bug. */
                    <span
                      className={item.tat.backdated ? styles.tatDone : (item.tat.delayed ? styles.tatDoneLate : styles.tatDone)}
                      title={item.tat.backdated
                        ? `FMS already had this movement recorded on ${formatActionTimestamp(item.tat.completedAt)}, before this record's own Stage 2 entry on ${formatActionTimestamp(item.tat.startedAt)} — transported ahead of the paperwork.`
                        : `Started ${formatActionTimestamp(item.tat.startedAt)} · Completed ${formatActionTimestamp(item.tat.completedAt)}`}
                    >
                      {item.tat.backdated
                        ? 'Completed · already on record'
                        : `Completed · ${item.tat.elapsed}${item.tat.delayed ? ` (${item.tat.overdueBy} late)` : ''}`}
                    </span>
                  )
                  : (
                    <span
                      className={item.tat.delayed ? styles.tatLate : styles.tatOk}
                      title={`Waiting since ${formatActionTimestamp(item.tat.startedAt)}`}
                    >
                      {item.tat.elapsed}{item.tat.delayed ? ` · ${item.tat.overdueBy} over` : ''}
                    </span>
                  )
                : '—'}</td>]
              : [])
          ]}
          /* A read-only stage still opens — canEdit is false there, so the
             button reads View and the modal comes up with its fields locked
             and no submit. Looking at a record is not editing it. */
          renderActions={(r) => {
            const isBusy = busyKey === r.row?.[0];
            return (
              <div className={styles.rowActions}>
                <Button size="sm" variant={canEdit ? 'primary' : 'secondary'} onClick={() => setActiveRow(r)} disabled={isBusy}>
                  {canEdit ? 'Open' : 'View'}
                </Button>
                {stage1Extras && canEdit && subTab === 'pending' && (
                  <Button size="sm" variant="secondary" disabled={isBusy} onClick={() => setHoldTarget(r)}>
                    Hold
                  </Button>
                )}
                {stage1Extras && canEdit && subTab === 'hold' && (
                  <Button size="sm" variant="secondary" loading={isBusy} disabled={isBusy} onClick={() => handleSendBackToStage1(r)}>
                    Send Back to Stage 1
                  </Button>
                )}
                {stage1Extras && canEdit && subTab === 'reject' && (
                  <Button size="sm" variant="secondary" loading={isBusy} disabled={isBusy} onClick={() => handleSendRejectedToStage1(r)}>
                    Send Back to Stage 1
                  </Button>
                )}
              </div>
            );
          }}
        />

        <Pagination page={page} totalPages={totalPages} onPrev={prevPage} onNext={nextPage} onPage={setPage} />
      </Card>

      {activeRow && (
        <StageDetailModal
          stageNumber={stageNumber}
          containerNo={activeRow.row[0]}
          rowNum={activeRow._rowNum}
          readOnly={!canEdit}
          identityOnly={readOnly}
          /* STAGE-8 / STAGE-9 detail for this container, matched server-side.
             Shown here rather than as grid columns — ten mostly-blank columns
             made the table unreadable. */
          movement={activeRow.movement}
          transport={activeRow.transport}
          delivery={activeRow.delivery}
          onClose={() => setActiveRow(null)}
          onSaved={() => { setActiveRow(null); reload(); }}
        />
      )}

      {stage1Extras && (
        <HoldModal
          open={!!holdTarget}
          item={holdTarget}
          submitting={holdBusy}
          error={holdError}
          onClose={() => { setHoldTarget(null); setHoldError(''); }}
          onSubmit={handleHoldSubmit}
        />
      )}
    </>
  );
}
