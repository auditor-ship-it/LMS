import { useMemo, useState } from 'react';
import { PageHeader, Card, Button, StatCard, SearchBar, Pagination, DataGrid, renderCellValue } from '../../components/ui/index.js';
import { useAsync } from '../../hooks/useAsync.js';
import { usePagination } from '../../hooks/usePagination.js';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import { usePermission } from '../../hooks/usePermission.js';
import { useAutoRefresh } from '../../hooks/useAutoRefresh.js';
import { invalidate } from '../../shared/dataBus.js';
import { useAuth, apiErrorMessage } from '../../shared/auth/index.js';
import { fetchRenewList, fetchDocumentList, submitRenewal, submitDocumentCompletion } from '../../services/renewDocument.service.js';
import { uploadStageFile } from '../../services/upload.service.js';
import { isRateOrAmountHeader } from '../../utils/isRateOrAmountHeader.js';
import { RenewModal } from './RenewModal.jsx';
import { CompleteDocumentModal } from './CompleteDocumentModal.jsx';
import styles from './RenewDocumentPage.module.css';

const TABS = [
  { key: 'renewed', label: 'Renewed' },
  { key: 'documents', label: 'Documents' }
];

// Kept out of the compact table view and shown only in the row detail panel.
const DETAIL_ONLY_HEADERS = /^(location|size|type|city|po)$/i;

/**
 * Renew & Document — the main app's Lease Expiry "Renewed"/"Documents"
 * sub-tabs, promoted to their own page. Both tabs read GET /expiry?filter=…
 * (renewed | documents). Renewed rows open a small "Update Lease Period"
 * form; Documents rows open a fuller "Complete Document Stage" form.
 * Clicking a row opens the full record first (same pattern as Verify Lease /
 * Approve Lease / Lease Expiry), with the same action available from there.
 */
// Both tabs' counts, independent of which one is active — a real "how much
// is pending" summary, same treatment as every other page's KPI band.
// Mockup called these "Not started/In discussion/Renewed/Lost" — this page's
// actual data only has two real states (renewed-pending-a-period-update,
// documents-pending-upload), so it gets two honest cards, not four
// placeholder ones this data can't back up.
async function fetchPipelineCounts() {
  const [renewed, documents] = await Promise.all([fetchRenewList(), fetchDocumentList()]);
  return { renewed: renewed?.data?.length ?? 0, documents: documents?.data?.length ?? 0 };
}

export function RenewDocumentPage() {
  const [tab, setTab] = useState('renewed');
  const fetcher = useMemo(() => (tab === 'renewed' ? fetchRenewList : fetchDocumentList), [tab]);
  const { data, loading, error, reload } = useAsync(fetcher, [tab]);
  const { data: counts, reload: reloadCounts } = useAsync(fetchPipelineCounts, []);
  // Lease Expiry's Renew/Off-Lease actions write the same Deployed-sheet
  // columns this page reads — without this, arriving here after an action
  // there would still show whatever was last fetched (KeepAlivePages keeps
  // every visited page mounted and only fetches once per session).
  const reloadBoth = () => { reload(); reloadCounts(); };
  useAutoRefresh('deployed-sheet', reloadBoth);
  const { canAct } = usePermission();
  const { user } = useAuth();
  const canActRenew = canAct('renew');

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 250);
  const [selectedContainer, setSelectedContainer] = useState(null);

  const [renewItem, setRenewItem] = useState(null);
  const [renewBusy, setRenewBusy] = useState(false);
  const [renewError, setRenewError] = useState('');

  const [docItem, setDocItem] = useState(null);
  const [docBusy, setDocBusy] = useState(false);
  const [docError, setDocError] = useState('');

  /* Bulk selection, keyed by container number — same identity
     setSelectedContainer already uses for the single-row detail view, and
     stable across pagination/filtering (unlike a row index, which shifts
     depending on which page or filtered set it's read from). Cleared on tab
     switch (Renewed and Documents are different container sets). */
  const [selectedKeys, setSelectedKeys] = useState(() => new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState('');

  const headers = data?.headers || [];
  const rows = data?.data || [];
  const validColIdx = data?.validColIdx ?? -1;
  const deployedIdx = useMemo(
    () => headers.findIndex((h) => String(h || '').toLowerCase().includes('deployed')),
    [headers]
  );

  // System-wide: rate/amount/pricing columns are hidden from every data grid.
  const visibleColIdx = useMemo(
    () => headers.map((_, i) => i).filter((i) => !isRateOrAmountHeader(headers[i])),
    [headers]
  );
  // The compact table view drops Location/Size/Type/City — those only show in the detail panel.
  const tableColIdx = useMemo(
    () => visibleColIdx.filter((i) => !DETAIL_ONLY_HEADERS.test(String(headers[i] || '').trim())),
    [visibleColIdx, headers]
  );
  const tableHeaders = tableColIdx.map((i) => headers[i]);

  const filtered = useMemo(() => {
    const term = debouncedSearch.trim().toLowerCase();
    if (!term) return rows;
    return rows.filter((r) => (r.row || []).some((v) => String(v ?? '').toLowerCase().includes(term)));
  }, [rows, debouncedSearch]);

  const { page, totalPages, pageRows, setPage, nextPage, prevPage, resetPage } = usePagination(filtered, 10);

  const selected = selectedContainer != null ? filtered.find((it) => it.row?.[0] === selectedContainer) : null;

  // Derived from `filtered`, not just the current page, so a selection made
  // on page 1 survives navigating to page 2.
  const selectedItems = useMemo(
    () => filtered.filter((r) => selectedKeys.has(r.row?.[0])),
    [filtered, selectedKeys]
  );

  const switchTab = (key) => { setTab(key); setSearch(''); setSelectedContainer(null); setSelectedKeys(new Set()); resetPage(); };
  const handleSearchChange = (v) => { setSearch(v); resetPage(); };

  const toggleRow = (key) => setSelectedKeys((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const toggleAllOnPage = () => setSelectedKeys((prev) => {
    const pageKeys = pageRows.map((r) => r.row?.[0]).filter(Boolean);
    const allSelected = pageKeys.length > 0 && pageKeys.every((k) => prev.has(k));
    const next = new Set(prev);
    pageKeys.forEach((k) => (allSelected ? next.delete(k) : next.add(k)));
    return next;
  });

  const openRenew = (item) => {
    setRenewError('');
    setRenewItem({
      containerNo: item.row?.[0],
      currentValidUpto: validColIdx >= 0 ? item.row?.[validColIdx] : '',
      deployedDate: deployedIdx >= 0 ? item.row?.[deployedIdx] : ''
    });
  };

  const handleRenewSubmit = async (payload) => {
    if (!renewItem) return;
    setRenewBusy(true);
    setRenewError('');
    try {
      await submitRenewal({
        containerNo: renewItem.containerNo,
        newDateString: payload.newDate
      });
      setRenewItem(null);
      setSelectedContainer(null);
      // Write, then read, sequentially — see LeaseExpiryPage's runAction for
      // why: a self-triggered background reload racing an in-flight write's
      // own reflection is what caused rows to visibly update then revert.
      await reload();
      await reloadCounts();
      invalidate('deployed-sheet');
    } catch (e) {
      setRenewError(apiErrorMessage(e));
    } finally {
      setRenewBusy(false);
    }
  };

  const openDoc = (item) => { setDocError(''); setDocItem({ containerNo: item.row?.[0] }); };

  const handleDocSubmit = async (payload) => {
    if (!docItem) return;
    setDocBusy(true);
    setDocError('');
    try {
      // Uploaded concurrently, not one after the other — the PO file has no
      // reason to wait on the signed copy finishing first, and this was
      // roughly doubling the wait whenever a form carried both.
      const [signedCopyUrl, poFileUrl] = await Promise.all([
        payload.signedCopy ? uploadStageFile(payload.signedCopy) : '',
        payload.poFile ? uploadStageFile(payload.poFile) : ''
      ]);

      const result = await submitDocumentCompletion({
        containerNo: docItem.containerNo,
        renewedDate: payload.renewedDate,
        validTill: payload.validTill,
        signedCopyUrl,
        remarks: payload.remarks,
        userEmail: user?.email || '',
        poNo: payload.poNo,
        poFileUrl,
        billingCycle: payload.billingCycle,
        poValidity: payload.poValidity
      });
      if (result === 'INVALID_STATE') setDocError('Container is not in the document-upload stage.');
      else if (result === 'MISSING_PO') setDocError('A PO number/file URL is required first.');
      else if (result === 'MISSING_AGR') setDocError('A signed agreement copy URL is required first.');
      else {
        setDocItem(null); setSelectedContainer(null);
        await reload();
        await reloadCounts();
        invalidate('deployed-sheet');
      }
    } catch (e) {
      setDocError(apiErrorMessage(e));
    } finally {
      setDocBusy(false);
    }
  };

  /* Bulk actions — one form, same values applied to every selected
     container, run in parallel (not one-after-another) since these are
     independent writes to different rows. A per-container failure is
     reported by container number rather than failing the whole batch
     silently or losing which ones actually went through. */
  const handleBulkRenewSubmit = async (payload) => {
    if (!selectedItems.length) return;
    setBulkBusy(true);
    setBulkError('');
    try {
      const results = await Promise.allSettled(selectedItems.map((it) =>
        submitRenewal({ containerNo: it.row?.[0], newDateString: payload.newDate })));
      const failed = results
        .map((r, i) => (r.status === 'rejected' ? selectedItems[i].row?.[0] : null))
        .filter(Boolean);
      if (failed.length) {
        setBulkError(`Failed for: ${failed.join(', ')}. The rest were updated.`);
      } else {
        setBulkOpen(false);
        setSelectedKeys(new Set());
      }
      await reload();
      await reloadCounts();
      invalidate('deployed-sheet');
    } catch (e) {
      setBulkError(apiErrorMessage(e));
    } finally {
      setBulkBusy(false);
    }
  };

  const handleBulkDocSubmit = async (payload) => {
    if (!selectedItems.length) return;
    setBulkBusy(true);
    setBulkError('');
    try {
      // Uploaded ONCE — every selected container gets the same file/URL,
      // per the "one form entry for the whole batch" request.
      const [signedCopyUrl, poFileUrl] = await Promise.all([
        payload.signedCopy ? uploadStageFile(payload.signedCopy) : '',
        payload.poFile ? uploadStageFile(payload.poFile) : ''
      ]);

      const results = await Promise.allSettled(selectedItems.map(async (it) => {
        const result = await submitDocumentCompletion({
          containerNo: it.row?.[0],
          renewedDate: payload.renewedDate,
          validTill: payload.validTill,
          signedCopyUrl,
          remarks: payload.remarks,
          userEmail: user?.email || '',
          poNo: payload.poNo,
          poFileUrl,
          billingCycle: payload.billingCycle,
          poValidity: payload.poValidity
        });
        if (result === 'INVALID_STATE' || result === 'MISSING_PO' || result === 'MISSING_AGR') {
          throw new Error(result);
        }
      }));
      const failed = results
        .map((r, i) => (r.status === 'rejected' ? selectedItems[i].row?.[0] : null))
        .filter(Boolean);
      if (failed.length) {
        setBulkError(`Failed for: ${failed.join(', ')}. The rest were updated.`);
      } else {
        setBulkOpen(false);
        setSelectedKeys(new Set());
      }
      await reload();
      await reloadCounts();
      invalidate('deployed-sheet');
    } catch (e) {
      setBulkError(apiErrorMessage(e));
    } finally {
      setBulkBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Renew & Document"
        subtitle="Update lease periods for renewed containers and complete post-renewal documentation"
        actions={<Button variant="secondary" size="sm" onClick={reloadBoth}>Refresh</Button>}
      />

      <div className={styles.kpiRow}>
        <StatCard
          icon="clock" label="Renew Pending" value={counts?.renewed ?? '—'} tint="warn"
          footnote={counts?.renewed > 0 ? 'Needs a lease-period update' : undefined}
          active={tab === 'renewed'} onClick={() => switchTab('renewed')}
        />
        <StatCard
          icon="edit" label="Documents Pending" value={counts?.documents ?? '—'} tint="amber"
          footnote={counts?.documents > 0 ? 'Needs agreement/PO upload' : undefined}
          active={tab === 'documents'} onClick={() => switchTab('documents')}
        />
      </div>

      <div className={styles.tabRow}>
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`${styles.tab} ${tab === t.key ? styles.tabActive : ''}`}
            onClick={() => switchTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <Card>
        {!selected ? (
          <>
            <div className={styles.toolbar}>
              <SearchBar value={search} onChange={handleSearchChange} placeholder="Search container, client…" />
            </div>

            {/* Only when there's something to act on — a scoped/view-only
                caller can select rows (harmless) but has no action to run
                on them, so the bar showing an "Update" button with nothing
                behind it would be misleading. */}
            {canActRenew && selectedItems.length > 0 && (
              <div className={styles.bulkBar}>
                <span className={styles.bulkCount}>{selectedItems.length} selected</span>
                <Button size="sm" variant="secondary" onClick={() => setSelectedKeys(new Set())}>Clear</Button>
                <Button size="sm" variant="primary" onClick={() => { setBulkError(''); setBulkOpen(true); }}>
                  {tab === 'renewed' ? 'Update Period' : 'Update Agreement'} ({selectedItems.length})
                </Button>
              </div>
            )}

            <DataGrid
              /* No 'Action' header here: DataGrid appends its own 'Actions'
                 column whenever renderActions is passed. Adding one manually
                 gave two headers for one cell, so the button sat under
                 'Action' and 'Actions' rendered permanently empty. */
              headers={tableHeaders}
              rows={pageRows}
              loading={loading}
              error={error}
              onRetry={reloadBoth}
              emptyMessage={tab === 'renewed' ? 'No renewed containers awaiting a lease-period update' : 'No containers awaiting document completion'}
              selectable={canActRenew}
              selectedKeys={selectedKeys}
              onToggleRow={toggleRow}
              onToggleAll={toggleAllOnPage}
              rowKey={(r) => r.row?.[0]}
              renderRow={(values, item) => tableColIdx.map((ci) => (
                <td key={ci} className={styles.clickCell} onClick={() => setSelectedContainer(item.row?.[0])}>
                  {renderCellValue(values[ci])}
                </td>
              ))}
              renderActions={(item) => (
                canActRenew
                  ? (tab === 'renewed'
                    ? <Button size="sm" variant="secondary" onClick={() => openRenew(item)}>Update Period</Button>
                    : <Button size="sm" variant="primary" onClick={() => openDoc(item)}>Update Agreement</Button>)
                  : <span className={styles.viewOnly}>View only</span>
              )}
            />

            <Pagination page={page} totalPages={totalPages} onPrev={prevPage} onNext={nextPage} onPage={setPage} />
          </>
        ) : (
          <RenewDocumentDetail
            item={selected}
            headers={headers}
            visibleColIdx={visibleColIdx}
            total={filtered.length}
            tab={tab}
            canAct={canActRenew}
            onBack={() => setSelectedContainer(null)}
            onAction={() => (tab === 'renewed' ? openRenew(selected) : openDoc(selected))}
          />
        )}
      </Card>

      <RenewModal
        open={!!renewItem}
        item={renewItem}
        submitting={renewBusy}
        error={renewError}
        onClose={() => setRenewItem(null)}
        onSubmit={handleRenewSubmit}
      />

      <CompleteDocumentModal
        open={!!docItem}
        item={docItem}
        submitting={docBusy}
        error={docError}
        onClose={() => setDocItem(null)}
        onSubmit={handleDocSubmit}
      />

      {tab === 'renewed' ? (
        <RenewModal
          open={bulkOpen}
          items={selectedItems.map((it) => ({ containerNo: it.row?.[0] }))}
          submitting={bulkBusy}
          error={bulkError}
          onClose={() => setBulkOpen(false)}
          onSubmit={handleBulkRenewSubmit}
        />
      ) : (
        <CompleteDocumentModal
          open={bulkOpen}
          items={selectedItems.map((it) => ({ containerNo: it.row?.[0] }))}
          submitting={bulkBusy}
          error={bulkError}
          onClose={() => setBulkOpen(false)}
          onSubmit={handleBulkDocSubmit}
        />
      )}
    </>
  );
}

function RenewDocumentDetail({ item, headers, visibleColIdx, total, tab, canAct, onBack, onAction }) {
  return (
    <div>
      <Button variant="secondary" size="sm" onClick={onBack} className={styles.backBtn}>← Back to List ({total})</Button>

      <div className={styles.detailCard}>
        <div className={styles.detailHeader}>
          <h4 className={styles.detailTitle}>{item.row[0]}</h4>
        </div>

        <div className={styles.detailGrid}>
          {visibleColIdx.map((ci) => (
            <div key={ci} className={styles.detailField}>
              <div className={styles.detailLabel}>{headers[ci] || `Column ${ci + 1}`}</div>
              <div className={styles.detailValue}>{renderCellValue(item.row[ci])}</div>
            </div>
          ))}
        </div>

        <div className={styles.detailFooter}>
          {canAct ? (
            <Button size="lg" variant={tab === 'renewed' ? 'secondary' : 'primary'} onClick={onAction}>
              {tab === 'renewed' ? 'Update Period' : 'Update Agreement'}
            </Button>
          ) : (
            <span className={styles.viewOnly}>View only</span>
          )}
        </div>
      </div>
    </div>
  );
}
