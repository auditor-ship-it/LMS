import { useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import {
  PageHeader, Card, Button, DataGrid, StatCard, LoadingState, ErrorState, renderCellValue
} from '../../components/ui/index.js';
import { useAsync } from '../../hooks/useAsync.js';
import { fetchOffLeaseDashboard } from '../../services/offLease.service.js';
import { getRenewalLog as fetchRenewalLog, getNewLeaseReport as fetchNewLease } from '../../api/expiry.api.js';
import styles from './ReportsPage.module.css';

/**
 * Reports — month-wise summaries across the lease lifecycle.
 *
 * ONE year/month filter at the top drives every report on the page. Each
 * report previously carried its own, which meant the page could show August
 * off-lease next to June renewals and read as a single coherent view when it
 * was not.
 *
 * Off-Lease comes from GET /offlease/dashboard and Renewals from
 * GET /expiry/renewal-log, so neither needs a new endpoint and both agree with
 * the screens that own that data.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Timestamp -> "YYYY-MM". Two formats occur and both must work:
 *   "11/08/2026 07:04:56"      dd/MM/yyyy — parsed by component, because
 *                              Date() reads dd/MM as MM/dd and would shift
 *                              every day <= 12 into the wrong month
 *   "2026-07-31T11:34:07.261Z" ISO — taken from the leading yyyy-MM
 */
function monthKeyOf(stamp) {
  const s = String(stamp || '').trim();
  const iso = s.match(/^(\d{4})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}`;
  const dmy = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (dmy) return `${dmy[3]}-${String(Number(dmy[2])).padStart(2, '0')}`;
  return '';
}

/** Stage 1 timestamp = when the container entered off-lease. */
const intimationStamp = (it) => String((it.stages || []).find((s) => s.stage === 1)?.timestamp || '').trim();

/** True when a row's month key passes the active year/month filter. */
function inRange(key, year, month) {
  if (year !== 'all' && !key.startsWith(year)) return false;
  if (month !== 'all' && key.slice(5) !== month) return false;
  return true;
}

export function ReportsPage() {
  const offlease = useAsync(fetchOffLeaseDashboard, []);
  const renewals = useAsync(fetchRenewalLog, []);
  const newLease = useAsync(fetchNewLease, []);

  /* Opens on the CURRENT month — a report is nearly always read for "now", and
     defaulting to everything meant scrolling months of history to reach it.
     "All years / All months" is still one click away.

     Year and month stay separate: a year on its own ("everything in 2026") is
     a view a single combined "Aug 2026" list could not express. */
  const [year, setYear] = useState(() => String(new Date().getFullYear()));
  const [month, setMonth] = useState(() => String(new Date().getMonth() + 1).padStart(2, '0'));

  const olItems = offlease.data?.items || [];
  const rnItems = renewals.data?.data || [];
  const nlItems = newLease.data?.data || [];

  /* Every month key on the page, from ALL reports — the filter is shared, so
     its options must cover everything it can filter. */
  const allKeys = useMemo(() => [
    ...olItems.map((it) => monthKeyOf(intimationStamp(it))),
    ...rnItems.map((r) => monthKeyOf(r.timestamp)),
    ...nlItems.map((r) => monthKeyOf(r.deployedDate))
  ].filter(Boolean), [olItems, rnItems, nlItems]);

  /* The CURRENT year and month are always offered, even with no data behind
     them — the page opens on them, and a select whose value is missing from
     its options renders blank and looks broken. An empty table under the
     current month is the honest answer: nothing happened yet. */
  const nowYear = String(new Date().getFullYear());
  const nowMonth = String(new Date().getMonth() + 1).padStart(2, '0');

  const years = useMemo(
    () => [...new Set([nowYear, ...allKeys.map((k) => k.slice(0, 4))])].sort((a, b) => b.localeCompare(a)),
    [allKeys, nowYear]
  );

  /* Only months that exist within the chosen year, so the dropdown can never
     offer one with nothing behind it. */
  const monthsInYear = useMemo(() => {
    const ms = allKeys.filter((k) => year === 'all' || k.startsWith(year)).map((k) => k.slice(5));
    if (year === nowYear || year === 'all') ms.push(nowMonth);
    return [...new Set(ms)].sort((a, b) => b.localeCompare(a));
  }, [allKeys, year, nowYear, nowMonth]);

  const offLeaseRows = useMemo(() => olItems
    .filter((it) => inRange(monthKeyOf(intimationStamp(it)), year, month))
    .map((it) => ({ ...it, _stamp: intimationStamp(it) }))
    .sort((a, b) => b._stamp.localeCompare(a._stamp)),
  [olItems, year, month]);

  const renewalRows = useMemo(() => rnItems
    .filter((r) => inRange(monthKeyOf(r.timestamp), year, month)),
  [rnItems, year, month]);

  const newLeaseRows = useMemo(() => nlItems
    .filter((r) => inRange(monthKeyOf(r.deployedDate), year, month)),
  [nlItems, year, month]);

  const loading = offlease.loading || renewals.loading || newLease.loading;
  const reloadAll = () => { offlease.reload(); renewals.reload(); newLease.reload(); };

  /* Exports exactly what is on screen — the same rows, under the same filter.
     A download that quietly contained everything would contradict the page it
     came from. One sheet per report, so each keeps its own columns. */
  const periodLabel = year === 'all'
    ? 'All periods'
    : `${month === 'all' ? 'All months' : MONTHS[Number(month) - 1]} ${year}`;

  const exportExcel = () => {
    const wb = XLSX.utils.book_new();

    const add = (name, headers, rows) => {
      const aoa = [[`${name} — ${periodLabel}`], [], headers, ...rows];
      const sheet = XLSX.utils.aoa_to_sheet(aoa);
      sheet['!cols'] = headers.map(() => ({ wch: 22 }));
      XLSX.utils.book_append_sheet(wb, sheet, name.slice(0, 31));
    };

    add('Off-Lease',
      ['Container No', 'Client Name', 'Lease ID', 'Size', 'Type', 'Location', 'Raised By'],
      offLeaseRows.map((it) => [it.container, it.clientName, it.leaseId, it.size, it.type, it.location, it.raisedBy]));

    add('New Lease',
      ['Deployed Date', 'Container No', 'Client Name', 'Order No', 'Order Type', 'Qty', 'Size', 'Type', 'Location', 'Sale Executive'],
      newLeaseRows.map((r) => [r.deployedDate, r.container, r.clientName, r.orderNo, r.orderType, r.qty, r.size, r.productType, r.location, r.saleExec]));

    add('Agreement Renewals',
      ['Renewed On', 'Container No', 'Client Name', 'Valid Till', 'PO No', 'PO File', 'Agreement File', 'Old PO No', 'Old PO File', 'Old Agreement File', 'Updated By'],
      renewalRows.map((r) => [r.timestamp, r.container, r.clientName, r.validTill, r.poNo, r.poFile, r.agreementFile, r.oldPoNo, r.oldPoFile, r.oldAgreementFile, r.updatedBy]));

    const stamp = periodLabel.replace(/[^A-Za-z0-9]+/g, '-');
    XLSX.writeFile(wb, `Reports-${stamp}.xlsx`);
  };

  return (
    <>
      <PageHeader title="Reports" subtitle="Month-wise summaries across the lease lifecycle" />

      <div className={styles.kpiRow}>
        <StatCard icon="package" label="Total off-lease" value={offLeaseRows.length} tint="navy" />
        <StatCard icon="edit" label="Total renewals" value={renewalRows.length} tint="info" />
        <StatCard icon="check" label="New leases" value={newLeaseRows.length} tint="success" />
      </div>

      {/* One filter for the whole page. */}
      <div className={styles.filterBar}>
        <label className={styles.filterLabel} htmlFor="rep-year">Year</label>
        <select
          id="rep-year"
          className={styles.monthSelect}
          value={year}
          /* Changing year resets month: the chosen month may not exist in the
             new year, leaving empty tables under a filter that looks valid. */
          onChange={(e) => { setYear(e.target.value); setMonth('all'); }}
        >
          <option value="all">All years</option>
          {years.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>

        <label className={styles.filterLabel} htmlFor="rep-month">Month</label>
        <select id="rep-month" className={styles.monthSelect} value={month} onChange={(e) => setMonth(e.target.value)}>
          <option value="all">All months</option>
          {monthsInYear.map((m) => <option key={m} value={m}>{MONTHS[Number(m) - 1] || m}</option>)}
        </select>

        <Button variant="secondary" size="sm" onClick={reloadAll} disabled={loading}>Refresh</Button>
        <Button
          variant="primary" size="sm" className={styles.exportBtn}
          onClick={exportExcel}
          disabled={loading || (!offLeaseRows.length && !newLeaseRows.length && !renewalRows.length)}
        >
          Export to Excel
        </Button>
      </div>

      <Card title="Off-Lease Report">
        {offlease.loading && <LoadingState label="Building report…" />}
        {!offlease.loading && offlease.error && <ErrorState message={offlease.error} onRetry={offlease.reload} />}
        {!offlease.loading && !offlease.error && (
          <DataGrid
            headers={['Container No', 'Client Name', 'Lease ID', 'Size', 'Type', 'Location', 'Raised By']}
            rows={offLeaseRows}
            rowKey={(r) => `${r.leaseId || ''}-${r.container}`}
            emptyMessage="No off-lease activity for this period"
            renderRow={(_v, it) => [
              <td key="c"><strong>{it.container}</strong></td>,
              <td key="n">{it.clientName || '—'}</td>,
              <td key="l">{it.leaseId || '—'}</td>,
              <td key="s">{it.size || '—'}</td>,
              <td key="t">{it.type || '—'}</td>,
              <td key="loc">{it.location || '—'}</td>,
              <td key="b">{it.raisedBy || '—'}</td>
            ]}
          />
        )}
      </Card>

      <Card title="New Lease Report">
        {newLease.loading && <LoadingState label="Loading new leases…" />}
        {!newLease.loading && newLease.error && <ErrorState message={newLease.error} onRetry={newLease.reload} />}
        {!newLease.loading && newLease.data?.error && <ErrorState message={newLease.data.error} onRetry={newLease.reload} />}
        {!newLease.loading && !newLease.error && !newLease.data?.error && (
          <DataGrid
            headers={[
              'Deployed Date', 'Container No', 'Client Name', 'Order No', 'Order Type',
              'Qty', 'Size', 'Type', 'Location', 'Sale Executive'
            ]}
            rows={newLeaseRows}
            rowKey={(r, i) => `${r.orderNo}-${r.container}-${i}`}
            emptyMessage="No new leases for this period"
            renderRow={(_v, r) => [
              <td key="d">{r.deployedDate || '—'}</td>,
              <td key="c"><strong>{r.container}</strong></td>,
              <td key="n">{r.clientName || '—'}</td>,
              <td key="o">{r.orderNo || '—'}</td>,
              <td key="ot">{r.orderType || '—'}</td>,
              <td key="q">{r.qty || '—'}</td>,
              <td key="s">{r.size || '—'}</td>,
              <td key="t">{r.productType || '—'}</td>,
              <td key="loc">{r.location || '—'}</td>,
              <td key="e">{r.saleExec || '—'}</td>
            ]}
          />
        )}
      </Card>

      <Card title="Agreement Renewal Report">
        {renewals.loading && <LoadingState label="Loading renewals…" />}
        {!renewals.loading && renewals.error && <ErrorState message={renewals.error} onRetry={renewals.reload} />}
        {!renewals.loading && renewals.data?.error && <ErrorState message={renewals.data.error} onRetry={renewals.reload} />}
        {!renewals.loading && !renewals.error && !renewals.data?.error && (
          <DataGrid
            headers={[
              'Renewed On', 'Container No', 'Client Name', 'Valid Till',
              'PO No', 'PO File', 'Agreement File',
              'Old PO No', 'Old PO File', 'Old Agreement File', 'Updated By'
            ]}
            rows={renewalRows}
            rowKey={(r, i) => `${r.container}-${r.timestamp}-${i}`}
            emptyMessage="No renewals for this period"
            renderRow={(_v, r) => [
              <td key="t">{r.timestamp || '—'}</td>,
              <td key="c"><strong>{r.container}</strong></td>,
              <td key="n">{r.clientName || '—'}</td>,
              <td key="v">{r.validTill || '—'}</td>,
              <td key="p">{r.poNo || '—'}</td>,
              <td key="pf">{renderCellValue(r.poFile)}</td>,
              <td key="af">{renderCellValue(r.agreementFile)}</td>,
              <td key="op">{r.oldPoNo || '—'}</td>,
              <td key="opf">{renderCellValue(r.oldPoFile)}</td>,
              <td key="oaf">{renderCellValue(r.oldAgreementFile)}</td>,
              <td key="u">{r.updatedBy || '—'}</td>
            ]}
          />
        )}
      </Card>
    </>
  );
}
