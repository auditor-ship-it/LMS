import { useMemo, useState } from 'react';
import { PageHeader, Card, StatCard, SearchBar, FilterBar, DataGrid, renderCellValue } from '../../components/ui/index.js';
import { useAsync } from '../../hooks/useAsync.js';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import { fetchReturnDashboard } from '../../services/verify.service.js';
import styles from './ReturnDashboardPage.module.css';

const HEADERS = ['Date', 'Container', 'Client Code', 'Client Name', 'Order No', 'Sale Executive', 'Issue', 'Remarks', 'By'];

/**
 * Return Dashboard — every "Send Back" (Follow Up with an Issue selected)
 * recorded on the Verify Lease screen, across the whole New Lease sheet
 * (not just currently-pending rows). Backed by GET /verify/return-dashboard.
 */
export function ReturnDashboardPage() {
  const { data, loading, error, reload } = useAsync(fetchReturnDashboard, []);
  const total = data?.total || 0;
  const byIssue = data?.byIssue || [];
  const items = data?.data || [];

  const [search, setSearch] = useState('');
  const [issueFilter, setIssueFilter] = useState('');
  const [execFilter, setExecFilter] = useState('');

  const debouncedSearch = useDebouncedValue(search, 200);

  const execOptions = useMemo(() => {
    const set = new Set();
    for (const it of items) if (it.saleExecutive) set.add(it.saleExecutive);
    return Array.from(set).sort().map((v) => ({ value: v, label: v }));
  }, [items]);

  const issueOptions = useMemo(() => byIssue.map((b) => ({ value: b.issue, label: `${b.issue} (${b.count})` })), [byIssue]);

  const filtered = useMemo(() => items.filter((it) => {
    if (issueFilter && it.issue !== issueFilter) return false;
    if (execFilter && it.saleExecutive !== execFilter) return false;
    if (debouncedSearch) {
      const q = debouncedSearch.toLowerCase();
      const hay = `${it.container} ${it.clientCode} ${it.clientName} ${it.orderNo} ${it.saleExecutive} ${it.issue} ${it.remarks} ${it.user}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }), [items, issueFilter, execFilter, debouncedSearch]);

  const rows = useMemo(() => filtered.map((it, i) => ({
    row: [it.date, it.container, it.clientCode, it.clientName, it.orderNo, it.saleExecutive, it.issue, it.remarks, it.user],
    id: `${it.container}-${it.date}-${i}`
  })), [filtered]);

  return (
    <>
      <PageHeader title="Return Dashboard" subtitle="Every lease sent back for an issue during verification" />

      <div className={styles.statRow}>
        <StatCard
          icon="refresh"
          label="Total Send Backs"
          value={loading ? '—' : total}
          tint="warn"
          footnoteSegments={byIssue.slice(0, 6).map((b) => ({
            key: b.issue,
            label: `${b.issue} · ${b.count}`,
            active: issueFilter === b.issue,
            onClick: () => setIssueFilter(issueFilter === b.issue ? '' : b.issue)
          }))}
        />
      </div>

      <Card>
        <div className={styles.controls}>
          <SearchBar value={search} onChange={setSearch} placeholder="Search container, client, remarks…" />
          <FilterBar
            filters={[
              { key: 'issue', label: 'Issue', options: issueOptions, value: issueFilter, onChange: setIssueFilter },
              { key: 'exec', label: 'Sale Executive', options: execOptions, value: execFilter, onChange: setExecFilter }
            ]}
          />
        </div>
        <p className={styles.hint}>{filtered.length} of {items.length} send-back{items.length === 1 ? '' : 's'}</p>
        <DataGrid
          headers={HEADERS}
          rows={rows}
          loading={loading}
          error={error}
          onRetry={reload}
          emptyMessage="No send-backs recorded"
          rowKey={(r) => r.id}
          renderRow={(values) => values.map((v, ci) => <td key={ci}>{renderCellValue(v)}</td>)}
        />
      </Card>
    </>
  );
}
