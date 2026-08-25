import { useEffect, useMemo, useState } from 'react';
import {
  PageHeader, Card, Button, SearchBar, Pagination, DataGrid, LoadingState, ErrorState, EmptyState, renderCellValue
} from '../../components/ui/index.js';
import { useAsync } from '../../hooks/useAsync.js';
import { usePolling } from '../../hooks/usePolling.js';
import { usePagination } from '../../hooks/usePagination.js';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import { usePermission } from '../../hooks/usePermission.js';
import { apiErrorMessage } from '../../shared/auth/index.js';
import { fetchApprovalQueue, decideApproval, lookupContainer } from '../../services/offLease.service.js';
import { getStageCounts as fetchStageCounts } from '../../api/offlease.api.js';
import { isRateOrAmountHeader } from '../../utils/isRateOrAmountHeader.js';
import { LookupResult } from './LookupResult.jsx';
import { exportLookupToExcel, exportLookupToPdf } from './lookupExport.js';
import { PipelineDashboard } from './PipelineDashboard.jsx';
import { StagePageBase } from '../stages/StagePageBase.jsx';
import { STAGES } from '../../constants/stages.js';
import styles from './OffLeasePage.module.css';

/* The approval gate is not a stage of its own — it sits BETWEEN Stage 1 and
   Stage 2 — so it is numbered 1A and placed immediately after Stage 1 rather
   than floating at the front of the strip, where the tab order implied
   approvals happened before intimation. */
const APPROVAL_TAB = { key: 'approval', label: 'Stage 1A (Approval)', countKey: 'approval' };

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
  const stageMatch = tab.match(/^stage(\d)$/);
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
  usePolling(() => reloadCounts({ silent: true }), 60000);

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

function ApprovalQueue() {
  const { data, loading, error, reload } = useAsync(() => fetchApprovalQueue(), []);
  usePolling(() => reload({ silent: true }), 60000);
  const { canAct } = usePermission();
  const canActApproval = canAct('offleaseapproval');

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 250);
  const [busyKey, setBusyKey] = useState('');
  const [actionError, setActionError] = useState('');

  /* Bulk selection, keyed by _rowNum. Cleared on every reload — same
     reasoning as Lease Expiry's bulk selection: a stale selection surviving
     a reload risks pointing at rows that have moved or already cleared. */
  const [selectedKeys, setSelectedKeys] = useState(() => new Set());
  const [bulkBusy, setBulkBusy] = useState('');
  useEffect(() => { setSelectedKeys(new Set()); }, [data]);

  const headers = data?.headers || [];
  const rows = data?.data || [];

  // System-wide: rate/amount/pricing columns are hidden from every data grid.
  const visibleColIdx = useMemo(
    () => headers.map((_, i) => i).filter((i) => !isRateOrAmountHeader(headers[i])),
    [headers]
  );
  const visibleHeaders = visibleColIdx.map((i) => headers[i]);

  const filtered = useMemo(() => {
    const term = debouncedSearch.trim().toLowerCase();
    if (!term) return rows;
    return rows.filter((r) => (r.row || []).some((v) => String(v ?? '').toLowerCase().includes(term)));
  }, [rows, debouncedSearch]);

  const { page, totalPages, pageRows, setPage, nextPage, prevPage, resetPage } = usePagination(filtered, 10);
  const handleSearchChange = (v) => { setSearch(v); resetPage(); };

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

  const decide = async (item, status) => {
    const key = `${item._rowNum}-${status}`;
    setBusyKey(key);
    setActionError('');
    try {
      const message = await decideApproval(item.row[0], status);
      if (message === 'ALREADY_PROCESSED') setActionError('This row was already actioned by someone else.');
      // Write, then read — one sequential reload, nothing racing it.
      await reload();
    } catch (e) {
      setActionError(apiErrorMessage(e));
    } finally {
      setBusyKey('');
    }
  };

  /* Bulk Approve/Reject — same shape as Lease Expiry's bulk actions: one
     write per container, run in parallel, no shared form data so no modal. */
  const decideBulk = async (status) => {
    if (!selectedItems.length) return;
    const containers = selectedItems.map((it) => it.row[0]);
    setBulkBusy(status);
    setActionError('');
    try {
      const results = await Promise.allSettled(containers.map((c) => decideApproval(c, status)));
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
      await reload();
    } catch (e) {
      setActionError(apiErrorMessage(e));
    } finally {
      setBulkBusy('');
    }
  };

  return (
    <Card title="Pending Approval" actions={<Button variant="secondary" size="sm" onClick={reload}>Refresh</Button>}>
      <div className={styles.toolbar}>
        <SearchBar value={search} onChange={handleSearchChange} placeholder="Search container, client…" />
      </div>

      {actionError && <p className={styles.actionError}>{actionError}</p>}

      {canActApproval && selectedItems.length > 0 && (
        <div className={styles.bulkBar}>
          <span className={styles.bulkCount}>{selectedItems.length} selected</span>
          <Button size="sm" variant="secondary" onClick={() => setSelectedKeys(new Set())}>Clear</Button>
          <Button size="sm" variant="primary" loading={bulkBusy === 'Approved'} disabled={!!bulkBusy} onClick={() => decideBulk('Approved')}>
            Approve ({selectedItems.length})
          </Button>
          <Button size="sm" variant="danger" loading={bulkBusy === 'Rejected'} disabled={!!bulkBusy} onClick={() => decideBulk('Rejected')}>
            Reject ({selectedItems.length})
          </Button>
        </div>
      )}

      <DataGrid
        headers={visibleHeaders}
        rows={pageRows}
        loading={loading}
        error={error}
        onRetry={reload}
        selectable={canActApproval}
        selectedKeys={selectedKeys}
        onToggleRow={toggleRow}
        onToggleAll={toggleAllOnPage}
        rowKey={(r) => r._rowNum}
        emptyMessage="No off-lease intimations awaiting approval"
        renderRow={(values) => visibleColIdx.map((ci) => <td key={ci}>{renderCellValue(values[ci])}</td>)}
        renderActions={canActApproval ? (item) => (
          <div className={styles.actionsCell}>
            <Button
              size="sm"
              variant="primary"
              loading={busyKey === `${item._rowNum}-Approved`}
              onClick={() => decide(item, 'Approved')}
            >
              Approve
            </Button>
            <Button
              size="sm"
              variant="danger"
              loading={busyKey === `${item._rowNum}-Rejected`}
              onClick={() => decide(item, 'Rejected')}
            >
              Reject
            </Button>
          </div>
        ) : undefined}
      />

      <Pagination page={page} totalPages={totalPages} onPrev={prevPage} onNext={nextPage} onPage={setPage} />
    </Card>
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

  // Both exports are built from `result`, which is already in memory — no
  // extra API call, so no loading state is needed here.
  const download = (fn) => () => {
    setDownloadError('');
    try {
      fn(result);
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
          <Button variant="secondary" size="sm" onClick={download(exportLookupToPdf)}>Download PDF</Button>
        </>
      ) : undefined}
    >
      {downloadError && <p className={styles.actionError}>{downloadError}</p>}

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
