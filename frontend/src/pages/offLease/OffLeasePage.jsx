import { useEffect, useMemo, useState } from 'react';
import {
  PageHeader, Card, Button, SearchBar, Pagination, DataGrid, LoadingState, ErrorState, EmptyState, renderCellValue
} from '../../components/ui/index.js';
import { useAsync } from '../../hooks/useAsync.js';
import { usePolling } from '../../hooks/usePolling.js';
import { useAutoRefresh } from '../../hooks/useAutoRefresh.js';
import { usePagination } from '../../hooks/usePagination.js';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import { usePermission } from '../../hooks/usePermission.js';
import { apiErrorMessage } from '../../shared/auth/index.js';
import { fetchApprovalQueue, decideApproval, sendBackToStage1FromApproval, decideClientToClient, lookupContainer } from '../../services/offLease.service.js';
import { RejectModal } from './RejectModal.jsx';
import { ClientToClientModal } from './ClientToClientModal.jsx';
import { getStageCounts as fetchStageCounts } from '../../api/offlease.api.js';
import { isRateOrAmountHeader } from '../../utils/isRateOrAmountHeader.js';
import { formatActionTimestamp } from '../../utils/formatDateTime.js';
import { LookupResult } from './LookupResult.jsx';
import { exportLookupToExcel, exportLookupToPdf } from './lookupExport.js';
import { useStageSelection, StageSelector } from './StageSelector.jsx';
import { PipelineDashboard } from './PipelineDashboard.jsx';
import { StagePageBase } from '../stages/StagePageBase.jsx';
import { STAGES } from '../../constants/stages.js';
import styles from './OffLeasePage.module.css';

/* The approval gate is not a stage of its own — it sits BETWEEN Stage 1 and
   Stage 2 — so it is numbered 1A and placed immediately after Stage 1 rather
   than floating at the front of the strip, where the tab order implied
   approvals happened before intimation. RENAMED 2026-09-18 (explicit
   request) from "Stage 1.2" to "Stage 1A" — no position change. */
const APPROVAL_TAB = { key: 'approval', label: 'Stage 1A (Pushpa)', countKey: 'approval' };

const TABS = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'lookup', label: 'Container Lookup' },
  // key uses the internal number (it routes to the stage's columns); the label
  // shows the display number so the tabs read Stage 1..7 with no gap.
  /* countKey is the INTERNAL stage number — the same key the API returns
     counts under. The display number is only ever the label. */
  ...STAGES.flatMap((s) => {
    const tab = {
      key: `stage${s.number}`,
      countKey: String(s.number),
      label: s.owner ? `Stage ${s.display} (${s.owner})` : `Stage ${s.display}`
    };
    return s.display === 1 ? [tab, APPROVAL_TAB] : [tab];
  })
];

/**
 * Off-Lease (parent page). Pending Approval (the queue between Stage 1 and
 * Stage 2) and Container Lookup, plus the full Stage 1..8 pipeline as
 * additional tabs here — the Stages sidebar branch was removed in favor of
 * this single-page tab bar covering the whole off-lease workflow.
 */
export function OffLeasePage() {
  const { canAct } = usePermission();
  /* Dashboard and Container Lookup are gated like every other Off-Lease
     permission (offleasedashboard/offleaselookup — see permissions.config.js).
     Both default to visible for anyone who already has some Off-Lease access,
     since that was every user's experience before this gate existed; Roles &
     Access can now narrow either one. The per-stage tabs are unaffected —
     they were never gated at the tab level, only their save actions were. */
  const visibleTabs = useMemo(() => TABS.filter((t) => {
    if (t.key === 'dashboard') return canAct('offleasedashboard');
    if (t.key === 'lookup') return canAct('offleaselookup');
    return true;
  }), [canAct]);

  const [tab, setTab] = useState(() => visibleTabs[0]?.key || 'dashboard');
  // \d+, not \d — internal stage numbers went double-digit (10) 2026-09-18;
  // a single-digit-only regex silently never matched that tab's key at all.
  const stageMatch = tab.match(/^stage(\d+)$/);
  /* One request for every badge — six stage-list calls from the client would
     be six round trips to render a row of numbers.

     `|| {}`, not a default parameter: useAsync returns NULL while loading and
     on error, and a default only applies to `undefined`. Tabs without a
     countKey then indexed null and the whole page crashed. */
  const { data: countsData, reload: reloadCounts } = useAsync(fetchStageCounts, []);
  const counts = countsData || {};
  // Badges reflect a container becoming eligible in the background (an
  // external Gate-In form submission, an FMS update) without a manual
  // refresh — see usePolling's doc comment.
  usePolling(() => reloadCounts({ silent: true }));
  useAutoRefresh('off-lease', () => reloadCounts({ silent: true }));

  return (
    <>
      <PageHeader
        title="Off-Lease"
        subtitle="Pending intimation approvals, container lookup, and the Stage 1–8 pipeline"
      />

      <div className={styles.tabRow}>
        {visibleTabs.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`${styles.tab} ${tab === t.key ? styles.tabActive : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
            {/* Only when the count is known AND non-zero — a "0" badge is
                noise, and showing one while counts are still loading would
                flash a wrong number. */}
            {counts[t.countKey] > 0 && (
              <span className={styles.tabCount}>{counts[t.countKey]}</span>
            )}
          </button>
        ))}
      </div>

      {/* canAct checked again here, not just in visibleTabs above — belt and
          braces against `tab` state ever landing on a gated key another way
          (e.g. a stale value from before a permission was revoked). */}
      {tab === 'dashboard' && canAct('offleasedashboard') && <PipelineDashboard onOpenTab={setTab} />}
      {tab === 'approval' && <ApprovalQueue />}
      {tab === 'lookup' && canAct('offleaselookup') && <ContainerLookup />}
      {stageMatch && <StagePageBase stageNumber={Number(stageMatch[1])} embedded />}
    </>
  );
}

/* Moved out of the Pending Approval table and into the row-click inline
   detail view instead — see visibleColIdx's own comment. Matched
   case-insensitively against getOffLeaseApprovalData's own displayHeaders.
   "Stage 1 Remark" put BACK into the visible table 2026-09-23 (explicit
   request): the approver wants to see (and click straight into) whatever
   remark Stage 1 left, without opening the row first just to find out
   there's nothing worth reading. Clicking that cell already opens the row
   detail like every other cell here (DataGrid's onRowClick fires on the
   row, not intercepted per-cell), so this doubles as "click the remark to
   open the approval". */
const APPROVAL_DETAIL_ONLY_HEADERS = new Set([
  'ol intimation date', 'ol date', 'email notification', 'final billing date',
  'stage 1 completed on'
]);

function ApprovalQueue() {
  /* 'pending' (default) or 'clientToClient' — see getOffLeaseApprovalData's
     own doc comment on the backend for why the latter exists: a "Client to
     Client" decision deliberately never releases into Stage 2, so without
     this second view those records would have nowhere left to be seen once
     decided. Explicit request 2026-09-23, same tab-row pattern as Stage 1's
     own Pending/Hold/Reject (StagePageBase.jsx). */
  const [subView, setSubView] = useState('pending');
  const { data, loading, error, reload } = useAsync(() => fetchApprovalQueue(subView === 'clientToClient' ? 'clientToClient' : undefined), [subView]);
  usePolling(() => reload({ silent: true }));
  useAutoRefresh('off-lease', () => reload({ silent: true }));
  const { canAct } = usePermission();
  const canActApproval = canAct('offleaseapproval');

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 250);
  const [actionError, setActionError] = useState('');

  /* Bulk selection, keyed by _rowNum. Cleared on every reload — same
     reasoning as Lease Expiry's bulk selection: a stale selection surviving
     a reload risks pointing at rows that have moved or already cleared. */
  const [selectedKeys, setSelectedKeys] = useState(() => new Set());
  useEffect(() => { setSelectedKeys(new Set()); }, [data]);

  const headers = data?.headers || [];
  const rows = data?.data || [];

  // System-wide: rate/amount/pricing columns are hidden from every data grid.
  // These extra ones (2026-09-11, explicit request) made this table too wide
  // to read without horizontal scrolling — moved into the row-click inline
  // detail view (ApprovalDetail, below) instead of sitting inline as columns.
  const visibleColIdx = useMemo(
    () => headers.map((_, i) => i).filter((i) => !isRateOrAmountHeader(headers[i]) && !APPROVAL_DETAIL_ONLY_HEADERS.has(String(headers[i] || '').trim().toLowerCase())),
    [headers]
  );
  const visibleHeaders = visibleColIdx.map((i) => headers[i]);
  // The inline row detail shows EVERYTHING (rate/amount excepted, same
  // system-wide rule) — the columns trimmed from the table above reappear
  // here instead of being lost.
  const detailColIdx = useMemo(
    () => headers.map((_, i) => i).filter((i) => !isRateOrAmountHeader(headers[i])),
    [headers]
  );

  const filtered = useMemo(() => {
    const term = debouncedSearch.trim().toLowerCase();
    if (!term) return rows;
    return rows.filter((r) => (r.row || []).some((v) => String(v ?? '').toLowerCase().includes(term)));
  }, [rows, debouncedSearch]);

  const { page, totalPages, pageRows, setPage, nextPage, prevPage, resetPage } = usePagination(filtered, 10);
  const handleSearchChange = (v) => { setSearch(v); resetPage(); };

  /* Row detail — click a row to replace the table with its full data +
     Approve/Send Back/Reject, same "Back to List" pattern as Lease Expiry's
     own detail view (LeaseExpiryPage.jsx). Reverted 2026-09-11 from an
     earlier popup-modal attempt at the same request — explicitly asked to
     match Lease Expiry's inline style instead. */
  const [selectedIdx, setSelectedIdx] = useState(null);
  const selected = selectedIdx != null ? filtered.find((it) => it._rowNum === selectedIdx) : null;
  const switchSubView = (key) => { setSubView(key); setSearch(''); setSelectedIdx(null); };

  const selectedItems = useMemo(
    () => filtered.filter((r) => selectedKeys.has(r._rowNum)),
    [filtered, selectedKeys]
  );
  const toggleRow = (key) => setSelectedKeys((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const toggleAllOnPage = () => setSelectedKeys((prev) => {
    const pageKeys = pageRows.map((r) => r._rowNum);
    const allSelected = pageKeys.length > 0 && pageKeys.every((k) => prev.has(k));
    const next = new Set(prev);
    pageKeys.forEach((k) => (allSelected ? next.delete(k) : next.add(k)));
    return next;
  });

  /* Approve (single + bulk) — RejectModal.jsx, same shape as Reject/Send
     Back below. CHANGED 2026-09-23 (explicit request): Approve used to write
     immediately on click; now it opens the same remarks-first modal Reject/
     Send Back already use, so a remark can be left at approval time too, not
     only on rejection. approveItem/approveItems null = closed. */
  const [approveItem, setApproveItem] = useState(null);
  const [approveItems, setApproveItems] = useState(null);
  const [approveBusy, setApproveBusy] = useState(false);
  const [approveError, setApproveError] = useState('');
  const closeApprove = () => { setApproveItem(null); setApproveItems(null); setApproveError(''); };

  const handleApproveSubmit = async (remarks) => {
    setApproveBusy(true);
    setApproveError('');
    try {
      if (approveItems) {
        const containers = approveItems.map((it) => it.row[0]);
        const results = await Promise.allSettled(approveItems.map((it) => decideApproval(it.row[0], 'Approved', remarks, it._rowNum)));
        const alreadyProcessed = results
          .map((r, i) => (r.status === 'fulfilled' && r.value === 'ALREADY_PROCESSED' ? containers[i] : null))
          .filter(Boolean);
        const failed = results
          .map((r, i) => (r.status === 'rejected' ? containers[i] : null))
          .filter(Boolean);
        const notes = [];
        if (alreadyProcessed.length) notes.push(`Already actioned by someone else: ${alreadyProcessed.join(', ')}.`);
        if (failed.length) notes.push(`Failed: ${failed.join(', ')}.`);
        if (notes.length) setActionError(notes.join(' '));
      } else if (approveItem) {
        const message = await decideApproval(approveItem.row[0], 'Approved', remarks, approveItem._rowNum);
        if (message === 'ALREADY_PROCESSED') setActionError('This row was already actioned by someone else.');
      }
      closeApprove();
      await reload();
    } catch (e) {
      setApproveError(apiErrorMessage(e));
    } finally {
      setApproveBusy(false);
    }
  };

  /* "Client to Client" (single only, no bulk — ClientToClientModal.jsx's own
     doc comment explains why) — a 4th outcome alongside Approve/Send Back/
     Reject. ctcItem null = closed. */
  const [ctcItem, setCtcItem] = useState(null);
  const [ctcBusy, setCtcBusy] = useState(false);
  const [ctcError, setCtcError] = useState('');
  const closeCtc = () => { setCtcItem(null); setCtcError(''); };

  const handleClientToClientSubmit = async (clientName, remarks) => {
    if (!ctcItem) return;
    setCtcBusy(true);
    setCtcError('');
    try {
      const message = await decideClientToClient(ctcItem.row[0], clientName, remarks, ctcItem._rowNum);
      if (message === 'ALREADY_PROCESSED') setActionError('This row was already actioned by someone else.');
      closeCtc();
      await reload();
    } catch (e) {
      setCtcError(apiErrorMessage(e));
    } finally {
      setCtcBusy(false);
    }
  };

  /* Reject (single + bulk) — RejectModal.jsx, mirroring RenewModal's
     item/items mutually-exclusive convention. rejectItem/rejectItems null =
     closed. */
  const [rejectItem, setRejectItem] = useState(null);
  const [rejectItems, setRejectItems] = useState(null);
  const [rejectBusy, setRejectBusy] = useState(false);
  const [rejectError, setRejectError] = useState('');
  const closeReject = () => { setRejectItem(null); setRejectItems(null); setRejectError(''); };

  const handleRejectSubmit = async (remarks) => {
    setRejectBusy(true);
    setRejectError('');
    try {
      if (rejectItems) {
        const containers = rejectItems.map((it) => it.row[0]);
        const results = await Promise.allSettled(rejectItems.map((it) => decideApproval(it.row[0], 'Rejected', remarks, it._rowNum)));
        const alreadyProcessed = results
          .map((r, i) => (r.status === 'fulfilled' && r.value === 'ALREADY_PROCESSED' ? containers[i] : null))
          .filter(Boolean);
        const failed = results
          .map((r, i) => (r.status === 'rejected' ? containers[i] : null))
          .filter(Boolean);
        const notes = [];
        if (alreadyProcessed.length) notes.push(`Already actioned by someone else: ${alreadyProcessed.join(', ')}.`);
        if (failed.length) notes.push(`Failed: ${failed.join(', ')}.`);
        if (notes.length) setActionError(notes.join(' '));
      } else if (rejectItem) {
        const message = await decideApproval(rejectItem.row[0], 'Rejected', remarks, rejectItem._rowNum);
        if (message === 'ALREADY_PROCESSED') setActionError('This row was already actioned by someone else.');
      }
      closeReject();
      await reload();
    } catch (e) {
      setRejectError(apiErrorMessage(e));
    } finally {
      setRejectBusy(false);
    }
  };

  /* Send Back — reopens Stage 1 for editing without cancelling the off-lease
     request at all (contrast Reject, which now cancels it outright). Single
     row only, same capture-a-remark-first shape as Reject, reusing the same
     modal component with different wording. */
  const [sendBackItem, setSendBackItem] = useState(null);
  const [sendBackBusy, setSendBackBusy] = useState(false);
  const [sendBackError, setSendBackError] = useState('');
  const closeSendBack = () => { setSendBackItem(null); setSendBackError(''); };

  const handleSendBackSubmit = async (remarks) => {
    if (!sendBackItem) return;
    setSendBackBusy(true);
    setSendBackError('');
    try {
      await sendBackToStage1FromApproval(sendBackItem.row[0], remarks, sendBackItem._rowNum);
      closeSendBack();
      await reload();
    } catch (e) {
      setSendBackError(apiErrorMessage(e));
    } finally {
      setSendBackBusy(false);
    }
  };

  return (
    <Card title="Pending Approval" actions={<Button variant="secondary" size="sm" onClick={reload}>Refresh</Button>}>
      {actionError && <p className={styles.actionError}>{actionError}</p>}

      {!selected ? (
        <>
          {/* Pending / Client to Client — a "Client to Client" decision
              deliberately never releases into Stage 2 (see
              getOffLeaseApprovalData's doc comment on the backend), so it
              needs its own place to still be seen once decided, same
              "drops out of the normal queue and appears here instead"
              pattern as Stage 1's own Pending/Hold/Reject. */}
          <div className={styles.tabRow}>
            <button
              type="button"
              className={`${styles.tab} ${subView === 'pending' ? styles.tabActive : ''}`}
              onClick={() => switchSubView('pending')}
            >
              Pending
            </button>
            <button
              type="button"
              className={`${styles.tab} ${subView === 'clientToClient' ? styles.tabActive : ''}`}
              onClick={() => switchSubView('clientToClient')}
            >
              Client to Client
            </button>
          </div>

          <div className={styles.toolbar}>
            <SearchBar value={search} onChange={handleSearchChange} placeholder="Search container, client…" />
          </div>

          {subView === 'pending' && canActApproval && selectedItems.length > 0 && (
            <div className={styles.bulkBar}>
              <span className={styles.bulkCount}>{selectedItems.length} selected</span>
              <Button size="sm" variant="secondary" onClick={() => setSelectedKeys(new Set())}>Clear</Button>
              <Button size="sm" variant="primary" onClick={() => setApproveItems(selectedItems)}>
                Approve ({selectedItems.length})
              </Button>
              <Button size="sm" variant="danger" onClick={() => setRejectItems(selectedItems)}>
                Reject ({selectedItems.length})
              </Button>
            </div>
          )}

          <DataGrid
            headers={[...visibleHeaders, ...(subView === 'pending' && data?.tatBudget ? [`TAT (${data.tatBudget})`] : [])]}
            rows={pageRows}
            loading={loading}
            error={error}
            onRetry={reload}
            selectable={subView === 'pending' && canActApproval}
            selectedKeys={selectedKeys}
            onToggleRow={toggleRow}
            onToggleAll={toggleAllOnPage}
            rowKey={(r) => r._rowNum}
            emptyMessage={subView === 'pending' ? 'No off-lease intimations awaiting approval' : 'No Client to Client transfers yet'}
            onRowClick={(item) => setSelectedIdx(item._rowNum)}
            renderRow={(values, item) => [
              ...visibleColIdx.map((ci) => <td key={ci}>{renderCellValue(values[ci])}</td>),
              ...(subView === 'pending' && data?.tatBudget
                ? [<td key="tat">{item?.tat
                  ? (
                    <>
                      <span className={item.tat.delayed ? styles.tatLate : styles.tatOk}>
                        {item.tat.elapsed}{item.tat.delayed ? ` · ${item.tat.overdueBy} over` : ''}
                      </span>
                      <span className={styles.tatMeta}>Started {formatActionTimestamp(item.tat.startedAt)}</span>
                    </>
                  )
                  : '—'}</td>]
                : [])
            ]}
          />

          <Pagination page={page} totalPages={totalPages} onPrev={prevPage} onNext={nextPage} onPage={setPage} />
        </>
      ) : (
        <ApprovalDetail
          key={selected._rowNum}
          item={selected}
          headers={headers}
          detailColIdx={detailColIdx}
          total={filtered.length}
          canAct={subView === 'pending' && canActApproval}
          onBack={() => setSelectedIdx(null)}
          onApprove={() => { setSelectedIdx(null); setApproveItem(selected); }}
          onSendBack={() => { setSelectedIdx(null); setSendBackItem(selected); }}
          onReject={() => { setSelectedIdx(null); setRejectItem(selected); }}
          onClientToClient={() => { setSelectedIdx(null); setCtcItem(selected); }}
        />
      )}

      <RejectModal
        open={!!(approveItem || approveItems)}
        item={approveItem}
        items={approveItems}
        submitting={approveBusy}
        error={approveError}
        onClose={closeApprove}
        onSubmit={handleApproveSubmit}
        titleWord="Approve"
        placeholder="Any remarks for this approval? (optional)"
        submitLabel="Approve"
        variant="primary"
      />

      <RejectModal
        open={!!(rejectItem || rejectItems)}
        item={rejectItem}
        items={rejectItems}
        submitting={rejectBusy}
        error={rejectError}
        onClose={closeReject}
        onSubmit={handleRejectSubmit}
      />

      <RejectModal
        open={!!sendBackItem}
        item={sendBackItem}
        submitting={sendBackBusy}
        error={sendBackError}
        onClose={closeSendBack}
        onSubmit={handleSendBackSubmit}
        titleWord="Send Back"
        placeholder="What needs fixing before this can be resubmitted? (optional)"
        submitLabel="Send Back"
        variant="secondary"
      />

      <ClientToClientModal
        open={!!ctcItem}
        item={ctcItem}
        submitting={ctcBusy}
        error={ctcError}
        onClose={closeCtc}
        onSubmit={handleClientToClientSubmit}
      />
    </Card>
  );
}

/**
 * Approval queue's inline row detail — same "Back to List" pattern as Lease
 * Expiry's own LeaseExpiryDetail, showing every column (rate/amount
 * excepted) rather than just the ones the table kept visible, plus
 * Approve/Client to Client/Send Back/Reject right here so a record can be
 * decided on without going back to the table first. Explicit request
 * 2026-09-11.
 *
 * This is now the ONLY place these four actions live — the table's own
 * inline Actions column was removed 2026-09-23 (explicit request) once
 * "Client to Client" made it a 4th stacked button per row, too tall/cramped
 * to sit inline. Clicking a row already opened this same detail view before
 * that removal, so nothing is lost — just one fewer (redundant, now
 * genuinely too cluttered) way to reach it.
 *
 * "Return Transportation PO Required?" briefly lived on this screen
 * (2026-09-18) before moving to Stage 1's own form the same day, where the
 * decision is made at intimation time, before it ever reaches Approval — see
 * stageFields.js's STAGE_FIELDS[1]. The parent renders this with
 * `key={item._rowNum}` so switching rows resets this local state.
 */
function ApprovalDetail({ item, headers, detailColIdx, total, canAct, onBack, onApprove, onSendBack, onReject, onClientToClient }) {
  const containerNo = item.row?.[0];

  return (
    <div>
      <Button variant="secondary" size="sm" onClick={onBack} className={styles.backBtn}>← Back to List ({total})</Button>

      <div className={styles.detailCard}>
        <div className={styles.detailHeader}>
          <h4 className={styles.detailTitle}>{containerNo}</h4>
        </div>

        <div className={styles.detailGrid}>
          {detailColIdx.map((ci) => (
            <div key={ci} className={styles.detailField}>
              <span className={styles.detailLabel}>{headers[ci]}</span>
              <span className={styles.detailValue}>{renderCellValue(item.row?.[ci]) || '—'}</span>
            </div>
          ))}
        </div>

        {canAct && (
          <div className={styles.detailFooter} style={{ marginTop: 16 }}>
            <Button size="sm" variant="primary" onClick={onApprove}>Approve</Button>
            <Button size="sm" variant="secondary" onClick={onClientToClient}>Client to Client</Button>
            <Button size="sm" variant="secondary" onClick={onSendBack}>Send Back</Button>
            <Button size="sm" variant="danger" onClick={onReject}>Reject</Button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Shown when one container number has more than one off-lease record — the
 * same box returned by different clients at different times. Picking a client
 * re-runs the lookup scoped to that lease, so the detail and the downloaded
 * report are unambiguously that one record.
 */
function ContainerMatchPicker({ container, matches, onPick }) {
  return (
    <div className={styles.pickerWrap}>
      <p className={styles.pickerTitle}>
        {container} has {matches.length} off-lease records — choose a client
      </p>
      <div className={styles.pickerList}>
        {matches.map((m) => (
          <button
            key={m.leaseId || m.clientName}
            type="button"
            className={styles.pickerCard}
            onClick={() => onPick(m.leaseId)}
          >
            <span className={styles.pickerClient}>{m.clientName || 'Unknown client'}</span>
            <span className={styles.pickerMeta}>
              {[m.leaseId, m.clientCode, [m.size, m.type].filter(Boolean).join(' · ')].filter(Boolean).join('  ·  ')}
            </span>
            <span className={styles.pickerMeta}>
              {[m.deployedDate && `Deployed ${m.deployedDate}`, m.validUpto && `Valid upto ${m.validUpto}`].filter(Boolean).join('  ·  ')}
            </span>
            {m.currentStage && <span className={styles.pickerStage}>{m.currentStage}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

function ContainerLookup() {
  const [term, setTerm] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [downloadError, setDownloadError] = useState('');

  /* `leaseId` picks one record when a container has been off-leased more than
     once — the same box returned by two different clients at different times.
     Without it the API hands back the candidate list instead of quietly
     showing whichever row happens to come first. */
  const search = async (e, leaseId) => {
    e?.preventDefault();
    const cn = term.trim();
    if (!cn) return;
    setLoading(true);
    setError('');
    setDownloadError('');
    try {
      const res = await lookupContainer(cn, leaseId);
      setResult(res);
    } catch (err) {
      setError(apiErrorMessage(err));
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  const clear = () => { setTerm(''); setResult(null); setError(''); setDownloadError(''); };

  const { filled, selected, toggle } = useStageSelection(result);

  // Both exports are built from `result`, which is already in memory — no
  // extra API call, so no loading state is needed here.
  const download = (fn, ...args) => () => {
    setDownloadError('');
    try {
      fn(result, ...args);
    } catch (err) {
      setDownloadError(err?.message || 'Could not build the download file.');
    }
  };

  // No download while the user is still choosing which record they mean.
  const canDownload = Boolean(result?.found && !result?.multiple);

  return (
    <Card
      title="Container Lookup"
      actions={canDownload ? (
        <>
          <Button variant="secondary" size="sm" onClick={download(exportLookupToExcel)}>Download Excel</Button>
          <Button variant="secondary" size="sm" onClick={download(exportLookupToPdf, selected)}>Download PDF</Button>
        </>
      ) : undefined}
    >
      {downloadError && <p className={styles.actionError}>{downloadError}</p>}
      {canDownload && filled.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <StageSelector filled={filled} selected={selected} onToggle={toggle} />
        </div>
      )}

      <form onSubmit={search} className={styles.searchRow}>
        <SearchBar value={term} onChange={setTerm} placeholder="Search by container number…" />
        <Button type="submit" variant="primary" loading={loading}>Search</Button>
        <Button type="button" variant="secondary" onClick={clear}>Clear</Button>
      </form>

      {loading && <LoadingState label="Looking up container…" />}
      {!loading && error && <ErrorState message={error} onRetry={search} />}
      {!loading && !error && result && !result.found && (
        <EmptyState message={result.message || 'Container not found'} />
      )}
      {!loading && !error && result?.multiple && (
        <ContainerMatchPicker
          container={result.container}
          matches={result.matches}
          onPick={(leaseId) => search(null, leaseId)}
        />
      )}
      {!loading && !error && result?.found && !result.multiple && <LookupResult result={result} />}
      {!loading && !error && !result && (
        <EmptyState message="Search for a container to see its off-lease status" hint="Enter a container number and press Search" />
      )}
    </Card>
  );
}
