import { useMemo, useState } from 'react';
import { PageHeader, Card, Button, SearchBar, FilterBar, Pagination, DataGrid, renderCellValue } from '../../components/ui/index.js';
import { useAsync } from '../../hooks/useAsync.js';
import { usePagination } from '../../hooks/usePagination.js';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import { usePermission } from '../../hooks/usePermission.js';
import { apiErrorMessage } from '../../shared/auth/index.js';
import { fetchApproveList, decideApproval } from '../../services/approve.service.js';
import { visibleColumnIndices, rowMatchesSearch, pickCategoricalFilterColumn, distinctOptionsForColumn } from '../../utils/tableFilters.js';
import { ApproveConfirmDialog } from './ApproveConfirmDialog.jsx';
import styles from './ApproveLeasePage.module.css';

// Kept out of the compact table view and shown only in the row detail panel.
const DETAIL_ONLY_HEADERS = /^(location|size|type|city|dispatch address|no\.? of container|billing cycle|no\.? of billing days|billing range)$/i;

/**
 * Approve Lease — the pending "New Lease" approval queue (GET /approve).
 * Decisions post to the same real backend endpoint the main app uses
 * (POST /approve/:rowNum/action, status: 'Approved' | 'Rejected'). Clicking
 * a row opens the full record (same pattern as Verify Lease / Lease Expiry).
 */
export function ApproveLeasePage() {
  const { canAct } = usePermission();
  const canApprove = canAct('approve');

  const { data, loading, error, reload } = useAsync(fetchApproveList, []);
  const headers = data?.headers || [];
  const items = data?.data || [];

  const [search, setSearch] = useState('');
  const [colFilter, setColFilter] = useState('');
  const [selectedRowNum, setSelectedRowNum] = useState(null);
  const [pendingReject, setPendingReject] = useState(null);
  const [submittingRowNum, setSubmittingRowNum] = useState(null);
  const [rejectError, setRejectError] = useState('');
  const [banner, setBanner] = useState(null);

  const debouncedSearch = useDebouncedValue(search, 200);

  const visibleColIdx = useMemo(() => visibleColumnIndices(headers), [headers]);
  // The compact table view drops Location/Size/Type/City — those only show in the detail panel.
  const tableColIdx = useMemo(
    () => visibleColIdx.filter((i) => !DETAIL_ONLY_HEADERS.test(String(headers[i] || '').trim())),
    [visibleColIdx, headers]
  );
  const tableHeaders = tableColIdx.map((i) => headers[i]);

  const filterColIdx = useMemo(() => pickCategoricalFilterColumn(headers, items, visibleColIdx), [headers, items, visibleColIdx]);
  const filterOptions = useMemo(() => distinctOptionsForColumn(items, filterColIdx), [items, filterColIdx]);
  const filterLabel = filterColIdx >= 0 ? (headers[filterColIdx] || 'Filter') : 'Filter';

  const filtered = useMemo(() => items.filter((it) => {
    if (colFilter && filterColIdx >= 0 && String((it.row || [])[filterColIdx] ?? '') !== colFilter) return false;
    return rowMatchesSearch(it.row, debouncedSearch);
  }), [items, debouncedSearch, colFilter, filterColIdx]);

  const { page, totalPages, pageRows, setPage, nextPage, prevPage, resetPage } = usePagination(filtered, 10);

  const selected = selectedRowNum != null ? filtered.find((it) => it._rowNum === selectedRowNum) : null;

  function onSearchChange(v) { setSearch(v); resetPage(); }
  function onFilterChange(v) { setColFilter(v); resetPage(); }

  async function doDecide(item, status) {
    if (submittingRowNum) return; // guard against double-submit while a request is in flight
    setSubmittingRowNum(item._rowNum);
    setRejectError('');
    try {
      const res = await decideApproval(item.row[0], { timestamp: new Date().toISOString(), status });
      if (res?.message === 'ALREADY_PROCESSED') {
        setBanner({ type: 'error', text: 'This row was already processed by someone else.' });
      } else {
        setBanner({ type: 'success', text: `Lease ${status.toLowerCase()}.` });
      }
      setPendingReject(null);
      setSelectedRowNum(null);
      reload();
      setTimeout(() => setBanner(null), 5000);
    } catch (e) {
      const msg = apiErrorMessage(e);
      if (status === 'Rejected') setRejectError(msg);
      else setBanner({ type: 'error', text: msg });
    } finally {
      setSubmittingRowNum(null);
    }
  }

  return (
    <>
      <PageHeader title="Approve Lease" subtitle="Pending lease approvals awaiting a decision" />

      {!canApprove && (
        <div className={styles.viewOnlyBanner}>View Only — you don&apos;t have permission to approve leases.</div>
      )}
      {banner && (
        <div className={`${styles.banner} ${banner.type === 'success' ? styles.bannerSuccess : styles.bannerError}`}>
          {banner.text}
        </div>
      )}

      <Card>
        {!selected ? (
          <>
            <div className={styles.controls}>
              <SearchBar value={search} onChange={onSearchChange} placeholder="Search approve records…" />
              {filterColIdx >= 0 && (
                <FilterBar
                  filters={[{
                    key: 'col',
                    label: filterLabel,
                    options: filterOptions,
                    value: colFilter,
                    onChange: onFilterChange
                  }]}
                />
              )}
            </div>
            <p className={styles.hint}>{filtered.length} of {items.length} pending approval{items.length === 1 ? '' : 's'} · click a row for details</p>
            <DataGrid
              headers={tableHeaders}
              rows={pageRows}
              loading={loading}
              error={error}
              onRetry={reload}
              emptyMessage="No pending approvals"
              rowKey={(r) => r._rowNum}
              renderRow={(values, item) => (
                <>
                  {tableColIdx.map((ci) => (
                    <td key={ci} className={styles.clickCell} onClick={() => setSelectedRowNum(item._rowNum)}>
                      {renderCellValue(values[ci])}
                    </td>
                  ))}
                </>
              )}
            />
            <div className={styles.paginationWrap}>
              <Pagination page={page} totalPages={totalPages} onPrev={prevPage} onNext={nextPage} onPage={setPage} />
            </div>
          </>
        ) : (
          <ApproveDetail
            item={selected}
            headers={headers}
            visibleColIdx={visibleColIdx}
            total={filtered.length}
            canAct={canApprove}
            submitting={submittingRowNum === selected._rowNum}
            onBack={() => setSelectedRowNum(null)}
            onApprove={() => doDecide(selected, 'Approved')}
            onReject={() => { setRejectError(''); setPendingReject(selected); }}
          />
        )}
      </Card>

      <ApproveConfirmDialog
        open={!!pendingReject}
        label={pendingReject?.row?.[0]}
        submitting={submittingRowNum === pendingReject?._rowNum}
        serverError={rejectError}
        onCancel={() => setPendingReject(null)}
        onConfirm={() => doDecide(pendingReject, 'Rejected')}
      />
    </>
  );
}

function ApproveDetail({ item, headers, visibleColIdx, total, canAct, submitting, onBack, onApprove, onReject }) {
  return (
    <div>
      <Button variant="secondary" size="sm" onClick={onBack} className={styles.backBtn}>← Back to List ({total} pending)</Button>

      <div className={styles.detailCard}>
        <div className={styles.detailHeader}>
          <h4 className={styles.detailTitle}>{item.row[0]}</h4>
          <span className={styles.badgeWarning}>Pending Approval</span>
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
            <div className={styles.actionsCell}>
              <Button size="lg" variant="secondary" onClick={onReject} disabled={submitting}>Reject</Button>
              <Button size="lg" variant="primary" loading={submitting} onClick={onApprove}>Approve</Button>
            </div>
          ) : (
            <span className={styles.viewOnlyIcon}>View Only</span>
          )}
        </div>
      </div>
    </div>
  );
}
