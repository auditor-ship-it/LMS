import { useMemo, useState } from 'react';
import {
  PageHeader, Card, Button, SearchBar, Pagination, DataGrid, LoadingState, ErrorState, EmptyState, renderCellValue
} from '../../components/ui/index.js';
import { useAsync } from '../../hooks/useAsync.js';
import { usePagination } from '../../hooks/usePagination.js';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import { usePermission } from '../../hooks/usePermission.js';
import { apiErrorMessage } from '../../shared/auth/index.js';
import { fetchApprovalQueue, decideApproval, lookupContainer } from '../../services/offLease.service.js';
import { isRateOrAmountHeader } from '../../utils/isRateOrAmountHeader.js';
import { LookupResult } from './LookupResult.jsx';
import { PipelineDashboard } from './PipelineDashboard.jsx';
import { StagePageBase } from '../stages/StagePageBase.jsx';
import { STAGES } from '../../constants/stages.js';
import styles from './OffLeasePage.module.css';

const TABS = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'approval', label: 'Pending Approval' },
  { key: 'lookup', label: 'Container Lookup' },
  ...STAGES.map((s) => ({ key: `stage${s.number}`, label: s.owner ? `Stage ${s.number} (${s.owner})` : `Stage ${s.number}` }))
];

/**
 * Off-Lease (parent page). Pending Approval (the queue between Stage 1 and
 * Stage 2) and Container Lookup, plus the full Stage 1..8 pipeline as
 * additional tabs here — the Stages sidebar branch was removed in favor of
 * this single-page tab bar covering the whole off-lease workflow.
 */
export function OffLeasePage() {
  const [tab, setTab] = useState('dashboard');
  const stageMatch = tab.match(/^stage(\d)$/);

  return (
    <>
      <PageHeader
        title="Off-Lease"
        subtitle="Pending intimation approvals, container lookup, and the Stage 1–8 pipeline"
      />

      <div className={styles.tabRow}>
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`${styles.tab} ${tab === t.key ? styles.tabActive : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'dashboard' && <PipelineDashboard onOpenTab={setTab} />}
      {tab === 'approval' && <ApprovalQueue />}
      {tab === 'lookup' && <ContainerLookup />}
      {stageMatch && <StagePageBase stageNumber={Number(stageMatch[1])} embedded />}
    </>
  );
}

function ApprovalQueue() {
  const { data, loading, error, reload } = useAsync(() => fetchApprovalQueue(), []);
  const { canAct } = usePermission();
  const canActApproval = canAct('offleaseapproval');

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 250);
  const [busyKey, setBusyKey] = useState('');
  const [actionError, setActionError] = useState('');

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

  const decide = async (item, status) => {
    const key = `${item._rowNum}-${status}`;
    setBusyKey(key);
    setActionError('');
    try {
      const message = await decideApproval(item.row[0], status);
      if (message === 'ALREADY_PROCESSED') setActionError('This row was already actioned by someone else.');
      reload();
    } catch (e) {
      setActionError(apiErrorMessage(e));
    } finally {
      setBusyKey('');
    }
  };

  return (
    <Card title="Pending Approval" actions={<Button variant="secondary" size="sm" onClick={reload}>Refresh</Button>}>
      <div className={styles.toolbar}>
        <SearchBar value={search} onChange={handleSearchChange} placeholder="Search container, client…" />
      </div>

      {actionError && <p className={styles.actionError}>{actionError}</p>}

      <DataGrid
        headers={visibleHeaders}
        rows={pageRows}
        loading={loading}
        error={error}
        onRetry={reload}
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

function ContainerLookup() {
  const [term, setTerm] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const search = async (e) => {
    e?.preventDefault();
    const cn = term.trim();
    if (!cn) return;
    setLoading(true);
    setError('');
    try {
      const res = await lookupContainer(cn);
      setResult(res);
    } catch (err) {
      setError(apiErrorMessage(err));
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  const clear = () => { setTerm(''); setResult(null); setError(''); };

  return (
    <Card title="Container Lookup">
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
      {!loading && !error && result?.found && <LookupResult result={result} />}
      {!loading && !error && !result && (
        <EmptyState message="Search for a container to see its off-lease status" hint="Enter a container number and press Search" />
      )}
    </Card>
  );
}
