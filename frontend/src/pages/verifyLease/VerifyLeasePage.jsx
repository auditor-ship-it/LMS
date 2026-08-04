import { useMemo, useState } from 'react';
import { PageHeader, Card, Button, SearchBar, FilterBar, Pagination, DataGrid, LogModal, renderCellValue } from '../../components/ui/index.js';
import { useAsync } from '../../hooks/useAsync.js';
import { usePagination } from '../../hooks/usePagination.js';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import { usePermission } from '../../hooks/usePermission.js';
import { apiErrorMessage } from '../../shared/auth/index.js';
import { fetchVerifyList, approveVerify, addVerifyFollowUp } from '../../services/verify.service.js';
import { visibleColumnIndices, rowMatchesSearch, pickCategoricalFilterColumn, distinctOptionsForColumn } from '../../utils/tableFilters.js';
import { VerifyApproveModal } from './VerifyApproveModal.jsx';
import { VerifyFollowUpModal } from './VerifyFollowUpModal.jsx';
import styles from './VerifyLeasePage.module.css';

function splitLog(str) {
  return String(str || '').split('\n').filter((x) => x.trim() !== '');
}

// Columns that stay in the detail view only — same "trim the list, keep it in
// the detail page" treatment already applied to Lease Expiry / Approve Lease
// / Renew & Document.
const DETAIL_ONLY_HEADERS = /^(dispatch address|size|product type|billing cycle|no\.? of billing days|billing range)$/i;

/**
 * Verify Lease — pending "New Lease" rows awaiting the billing/invoice
 * decision (GET /verify). Approving here is the same real backend action
 * the main app's Verify page performs (POST /verify/:rowNum/action), and
 * clicking a row opens the same detail view (with Follow Up + Follow-up
 * Log) the main app's Verify page has, backed by the same
 * POST /verify/:rowNum/follow-up endpoint.
 */
export function VerifyLeasePage() {
  const { canAct } = usePermission();
  const canVerify = canAct('verify');

  const { data, loading, error, reload } = useAsync(fetchVerifyList, []);
  const headers = data?.headers || [];
  const items = data?.data || [];

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [selectedRowNum, setSelectedRowNum] = useState(null);
  const [actionTarget, setActionTarget] = useState(null);
  const [followUpTarget, setFollowUpTarget] = useState(null);
  const [logTarget, setLogTarget] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState('');
  const [banner, setBanner] = useState(null); // { type: 'success'|'error', text }

  const debouncedSearch = useDebouncedValue(search, 200);

  const visibleColIdx = useMemo(() => visibleColumnIndices(headers), [headers]);
  const tableColIdx = useMemo(
    () => visibleColIdx.filter((i) => !DETAIL_ONLY_HEADERS.test(String(headers[i] || '').trim())),
    [visibleColIdx, headers]
  );
  const tableHeaders = useMemo(() => tableColIdx.map((i) => headers[i]), [tableColIdx, headers]);

  const filterColIdx = useMemo(() => pickCategoricalFilterColumn(headers, items, visibleColIdx), [headers, items, visibleColIdx]);
  const filterOptions = useMemo(() => distinctOptionsForColumn(items, filterColIdx), [items, filterColIdx]);
  const filterLabel = filterColIdx >= 0 ? (headers[filterColIdx] || 'Filter') : 'Filter';

  const filtered = useMemo(() => items.filter((it) => {
    if (statusFilter && filterColIdx >= 0 && String((it.row || [])[filterColIdx] ?? '') !== statusFilter) return false;
    return rowMatchesSearch(it.row, debouncedSearch);
  }), [items, debouncedSearch, statusFilter, filterColIdx]);

  const { page, totalPages, pageRows, setPage, nextPage, prevPage, resetPage } = usePagination(filtered, 10);

  const selected = selectedRowNum != null ? items.find((it) => it._rowNum === selectedRowNum) : null;

  function onSearchChange(v) { setSearch(v); resetPage(); }
  function onFilterChange(v) { setStatusFilter(v); resetPage(); }

  function openApprove(item) {
    setActionError('');
    setActionTarget(item);
  }

  async function submitApprove({ billingType, invoiceType, linkContainer }) {
    if (!actionTarget) return;
    setSubmitting(true);
    setActionError('');
    try {
      const res = await approveVerify(actionTarget.row[0], {
        timestamp: new Date().toISOString(),
        status: 'Approved',
        billingType,
        invoiceType,
        linkContainer
      });
      setActionTarget(null);
      setSelectedRowNum(null);
      if (res?.message === 'ALREADY_PROCESSED') {
        setBanner({ type: 'error', text: 'This row was already processed by someone else.' });
      } else {
        setBanner({ type: 'success', text: `Approved — ${billingType}, ${invoiceType}.` });
      }
      reload();
      setTimeout(() => setBanner(null), 5000);
    } catch (e) {
      setActionError(apiErrorMessage(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function submitFollowUp(remarks) {
    if (!followUpTarget) return;
    setSubmitting(true);
    try {
      await addVerifyFollowUp(followUpTarget.row[0], { timestamp: new Date().toISOString(), remarks });
      setFollowUpTarget(null);
      setBanner({ type: 'success', text: 'Follow-up recorded.' });
      reload();
      setTimeout(() => setBanner(null), 5000);
    } catch (e) {
      setBanner({ type: 'error', text: apiErrorMessage(e) });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <PageHeader title="Verify Lease" subtitle="New leases awaiting billing and invoice verification before approval" />

      {!canVerify && (
        <div className={styles.viewOnlyBanner}>View Only — you don&apos;t have permission to verify leases.</div>
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
              <SearchBar value={search} onChange={onSearchChange} placeholder="Search verify records…" />
              {filterColIdx >= 0 && (
                <FilterBar
                  filters={[{
                    key: 'col',
                    label: filterLabel,
                    options: filterOptions,
                    value: statusFilter,
                    onChange: onFilterChange
                  }]}
                />
              )}
            </div>
            <p className={styles.hint}>{filtered.length} of {items.length} pending verification{items.length === 1 ? '' : 's'} · click a row for details</p>
            <DataGrid
              headers={tableHeaders}
              rows={pageRows}
              loading={loading}
              error={error}
              onRetry={reload}
              emptyMessage="No pending verifications"
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
          <VerifyDetail
            item={selected}
            headers={headers}
            visibleColIdx={visibleColIdx}
            total={filtered.length}
            canAct={canVerify}
            onBack={() => setSelectedRowNum(null)}
            onApprove={() => openApprove(selected)}
            onFollowUp={() => setFollowUpTarget(selected)}
            onViewLog={() => setLogTarget(selected)}
          />
        )}
      </Card>

      <VerifyApproveModal
        open={!!actionTarget}
        container={actionTarget?.row?.[0] || ''}
        submitting={submitting}
        serverError={actionError}
        onClose={() => setActionTarget(null)}
        onSubmit={submitApprove}
      />
      <VerifyFollowUpModal
        open={!!followUpTarget}
        submitting={submitting}
        onClose={() => setFollowUpTarget(null)}
        onSubmit={submitFollowUp}
      />
      <LogModal
        open={!!logTarget}
        onClose={() => setLogTarget(null)}
        title="Follow-up History"
        dates={splitLog(logTarget?.logV)}
        remarks={splitLog(logTarget?.logW)}
        users={splitLog(logTarget?.logX)}
      />
    </>
  );
}

function VerifyDetail({ item, headers, visibleColIdx, total, canAct, onBack, onApprove, onFollowUp, onViewLog }) {
  const hasFollowLog = item.logV && item.logV.trim() !== '';
  return (
    <div>
      <Button variant="secondary" size="sm" onClick={onBack} className={styles.backBtn}>← Back to List ({total} pending)</Button>

      <div className={styles.detailCard}>
        <div className={styles.detailHeader}>
          <div>
            <h4 className={styles.detailTitle}>{item.row[0]}</h4>
            {item.row.length > 2 && <span className={styles.custCode}>{item.row[1]} · {item.row[2]}</span>}
          </div>
          <span className={styles.badgeWarning}>Pending Verification</span>
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
          <div className={styles.footerLeft}>
            {hasFollowLog && <Button variant="secondary" size="sm" onClick={onViewLog}>Follow-up Log</Button>}
            {canAct && <Button variant="secondary" size="sm" onClick={onFollowUp}>+ Follow Up</Button>}
          </div>
          {canAct ? (
            <Button variant="primary" size="lg" onClick={onApprove}>Approve Lease</Button>
          ) : (
            <span className={styles.viewOnlyIcon}>View Only</span>
          )}
        </div>
      </div>
    </div>
  );
}
