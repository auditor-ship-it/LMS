import { useMemo, useState } from 'react';
import { PageHeader, Card, Button, StatCard, SearchBar, Pagination, DataGrid, renderCellValue } from '../../components/ui/index.js';
import { useAsync } from '../../hooks/useAsync.js';
import { usePagination } from '../../hooks/usePagination.js';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import { usePermission } from '../../hooks/usePermission.js';
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

  const switchTab = (key) => { setTab(key); setSearch(''); setSelectedContainer(null); resetPage(); };
  const handleSearchChange = (v) => { setSearch(v); resetPage(); };

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
      reload();
      reloadCounts();
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
      let signedCopyUrl = '';
      let poFileUrl = '';
      if (payload.signedCopy) signedCopyUrl = await uploadStageFile(payload.signedCopy);
      if (payload.poFile) poFileUrl = await uploadStageFile(payload.poFile);

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
      else { setDocItem(null); setSelectedContainer(null); reload(); reloadCounts(); }
    } catch (e) {
      setDocError(apiErrorMessage(e));
    } finally {
      setDocBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Renew & Document"
        subtitle="Update lease periods for renewed containers and complete post-renewal documentation"
        actions={<Button variant="secondary" size="sm" onClick={reload}>Refresh</Button>}
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

            <DataGrid
              headers={[...tableHeaders, 'Action']}
              rows={pageRows}
              loading={loading}
              error={error}
              onRetry={reload}
              emptyMessage={tab === 'renewed' ? 'No renewed containers awaiting a lease-period update' : 'No containers awaiting document completion'}
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
