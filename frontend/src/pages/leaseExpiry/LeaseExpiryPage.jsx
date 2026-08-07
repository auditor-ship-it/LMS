import { useMemo, useState } from 'react';
import {
  PageHeader, Card, Button, StatusBadge, SearchBar, FilterBar, Pagination, DataGrid, StatCard, renderCellValue
} from '../../components/ui/index.js';
import { useAsync } from '../../hooks/useAsync.js';
import { usePagination } from '../../hooks/usePagination.js';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import { usePermission } from '../../hooks/usePermission.js';
import { apiErrorMessage } from '../../shared/auth/index.js';
import { fetchExpiryList, actionExpiryRow } from '../../services/expiry.service.js';
import { isRateOrAmountHeader } from '../../utils/isRateOrAmountHeader.js';
import styles from './LeaseExpiryPage.module.css';

// The KPI row shows one card per bucket. Critical/Warning/Safe are combined
// into a single "Upcoming" card (breakdown shown in its footnote) — Overdue
// stays separate since it's the actionable/urgent one, with its own 30/60d
// footnote breakdown.
const BAND_OPTIONS = [
  { value: 'overdue', label: 'Overdue', icon: 'alert', tint: 'error' },
  { value: 'upcoming', label: 'Upcoming', icon: 'clock', tint: 'warn' }
];

const BAND_LABEL = { overdue: 'Overdue', critical: 'Critical', warning: 'Warning', safe: 'Safe' };

/** Backend only classifies "overdue" as one band (days < 0) — the 30d/60d
 *  split shown inside that one card's footnote is computed here from the
 *  same daysLeft value it already sends, no backend change and no extra
 *  cards (one Overdue scorecard total, not three). */
function overdueMagnitudeBucket(item) {
  const magnitude = -item.daysLeft;
  if (magnitude <= 30) return 'le30';
  if (magnitude <= 60) return 'le60';
  return 'over60';
}

// Kept out of the compact table view and shown only in the row detail panel.
const DETAIL_ONLY_HEADERS = /^(location|size|type|city|billing cycle|po)$/i;

/**
 * Lease Expiry — deployed containers approaching/past their lease expiry
 * date. Backed by GET /expiry?filter=pending — `band`/`daysLeft` are
 * pre-computed server-side. Row actions post to /expiry/action with the
 * container number (row[0]) as the identifier, matching the main app.
 */
export function LeaseExpiryPage() {
  const { data, loading, error, reload } = useAsync(() => fetchExpiryList(), []);
  const { canAct } = usePermission();
  const canActExpiry = canAct('expiry');

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 250);
  const [band, setBand] = useState('');
  const [busyKey, setBusyKey] = useState('');
  const [actionError, setActionError] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(null);

  const headers = data?.headers || [];
  // Container No. alone isn't a unique row identifier — the same container
  // legitimately recurs across multiple orders/billing cycles (see
  // mongoSheetMapping.js's fullRefresh note on the Deployed sheet), so
  // selecting a row by container number could open a DIFFERENT row with the
  // same container. _idx (position in this load) is always unique per row.
  const rows = useMemo(() => (data?.data || []).map((r, i) => ({ ...r, _idx: i })), [data]);

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

  const bandCounts = useMemo(() => {
    const c = { overdue: 0, critical: 0, warning: 0, safe: 0 };
    for (const r of rows) if (r.band && c[r.band] !== undefined) c[r.band] += 1;
    return c;
  }, [rows]);

  const overdueBuckets = useMemo(() => {
    const b = { le30: 0, le60: 0, over60: 0 };
    for (const r of rows) if (r.band === 'overdue') b[overdueMagnitudeBucket(r)] += 1;
    return b;
  }, [rows]);

  const upcomingCount = bandCounts.critical + bandCounts.warning + bandCounts.safe;
  const bandValue = { overdue: bandCounts.overdue, upcoming: upcomingCount };

  const OVERDUE_BUCKET_LABEL = { le30: '≤30d', le60: '31-60d', over60: '60d+' };
  const bandSegments = {
    overdue: Object.entries(OVERDUE_BUCKET_LABEL).map(([bucket, label]) => ({
      key: bucket,
      label: `${label}: ${overdueBuckets[bucket]}`,
      active: band === `overdue-${bucket}`,
      onClick: () => handleBandChange(band === `overdue-${bucket}` ? '' : `overdue-${bucket}`)
    })),
    upcoming: [
      { key: 'critical', label: `Critical (≤7d): ${bandCounts.critical}`, active: band === 'critical', onClick: () => handleBandChange(band === 'critical' ? '' : 'critical') },
      { key: 'warning', label: `Warning (≤30d): ${bandCounts.warning}`, active: band === 'warning', onClick: () => handleBandChange(band === 'warning' ? '' : 'warning') },
      { key: 'safe', label: `Safe: ${bandCounts.safe}`, active: band === 'safe', onClick: () => handleBandChange(band === 'safe' ? '' : 'safe') }
    ]
  };

  const filtered = useMemo(() => {
    let list = rows;
    if (band === 'upcoming') list = list.filter((r) => r.band !== 'overdue');
    else if (band.startsWith('overdue-')) {
      const bucket = band.slice('overdue-'.length);
      list = list.filter((r) => r.band === 'overdue' && overdueMagnitudeBucket(r) === bucket);
    } else if (band) list = list.filter((r) => r.band === band);
    const term = debouncedSearch.trim().toLowerCase();
    if (term) list = list.filter((r) => (r.row || []).some((v) => String(v ?? '').toLowerCase().includes(term)));
    return list;
  }, [rows, band, debouncedSearch]);

  const { page, totalPages, pageRows, setPage, nextPage, prevPage, resetPage } = usePagination(filtered, 10);

  const selected = selectedIdx != null ? filtered.find((it) => it._idx === selectedIdx) : null;

  const handleSearchChange = (v) => { setSearch(v); resetPage(); };
  const handleBandChange = (v) => { setBand(v); resetPage(); };

  const runAction = async (item, status) => {
    const containerNo = item.row?.[0];
    const key = `${containerNo}-${status}`;
    setBusyKey(key);
    setActionError('');
    try {
      const result = await actionExpiryRow(containerNo, new Date().toISOString(), status);
      if (result === 'ALREADY_PROCESSED') setActionError(`${containerNo} was already actioned by someone else.`);
      setSelectedIdx(null);
      reload();
    } catch (e) {
      setActionError(apiErrorMessage(e));
    } finally {
      setBusyKey('');
    }
  };

  return (
    <>
      <PageHeader
        title="Lease Expiry"
        subtitle="Deployed containers approaching or past their lease expiry date"
        actions={<Button variant="secondary" size="sm" onClick={reload}>Refresh</Button>}
      />

      <div className={styles.kpiRow}>
        {BAND_OPTIONS.map((b) => (
          <StatCard
            key={b.value}
            icon={b.icon}
            tint={b.tint}
            label={b.label}
            value={bandValue[b.value]}
            footnoteSegments={bandSegments[b.value]}
            active={band === b.value || band.startsWith(`${b.value}-`) || (b.value === 'upcoming' && ['critical', 'warning', 'safe'].includes(band))}
            onClick={() => handleBandChange(band === b.value ? '' : b.value)}
          />
        ))}
      </div>

      <Card>
        {actionError && <p className={styles.actionError}>{actionError}</p>}

        {!selected ? (
          <>
            <div className={styles.toolbar}>
              <SearchBar value={search} onChange={handleSearchChange} placeholder="Search container, client…" />
              <FilterBar
                filters={[{ key: 'band', label: 'Ageing', options: BAND_OPTIONS, value: band, onChange: handleBandChange }]}
              />
            </div>

            <DataGrid
              className={styles.wrapTable}
              headers={[...tableHeaders, 'Ageing', 'Days Left']}
              rows={pageRows}
              rowKey={(r) => r._idx}
              loading={loading}
              error={error}
              onRetry={reload}
              emptyMessage="No pending lease expiries"
              renderRow={(values, item) => [
                ...tableColIdx.map((ci) => (
                  <td key={ci} className={styles.clickCell} onClick={() => setSelectedIdx(item._idx)}>
                    {renderCellValue(values[ci])}
                  </td>
                )),
                <td key="band" className={styles.clickCell} onClick={() => setSelectedIdx(item._idx)}>
                  <StatusBadge status={BAND_LABEL[item.band] || '—'} />
                </td>,
                <td key="days" className={styles.clickCell} onClick={() => setSelectedIdx(item._idx)}>
                  {formatDays(item.daysLeft)}
                </td>
              ]}
            />

            <Pagination page={page} totalPages={totalPages} onPrev={prevPage} onNext={nextPage} onPage={setPage} />
          </>
        ) : (
          <LeaseExpiryDetail
            item={selected}
            headers={headers}
            visibleColIdx={visibleColIdx}
            total={filtered.length}
            canAct={canActExpiry}
            busyKey={busyKey}
            onBack={() => setSelectedIdx(null)}
            onRenew={() => runAction(selected, 'Renewed')}
            onOffLease={() => runAction(selected, 'Off-Lease')}
          />
        )}
      </Card>
    </>
  );
}

function LeaseExpiryDetail({ item, headers, visibleColIdx, total, canAct, busyKey, onBack, onRenew, onOffLease }) {
  const containerNo = item.row?.[0];
  return (
    <div>
      <Button variant="secondary" size="sm" onClick={onBack} className={styles.backBtn}>← Back to List ({total})</Button>

      <div className={styles.detailCard}>
        <div className={styles.detailHeader}>
          <div>
            <h4 className={styles.detailTitle}>{containerNo}</h4>
          </div>
          <StatusBadge status={BAND_LABEL[item.band] || '—'} />
        </div>

        <div className={styles.detailGrid}>
          {visibleColIdx.map((ci) => (
            <div key={ci} className={styles.detailField}>
              <div className={styles.detailLabel}>{headers[ci] || `Column ${ci + 1}`}</div>
              <div className={styles.detailValue}>{renderCellValue(item.row[ci])}</div>
            </div>
          ))}
          <div className={styles.detailField}>
            <div className={styles.detailLabel}>Days Left</div>
            <div className={styles.detailValue}>{formatDays(item.daysLeft)}</div>
          </div>
        </div>

        <div className={styles.detailFooter}>
          {canAct ? (
            <div className={styles.actionsCell}>
              <Button size="lg" variant="primary" loading={busyKey === `${containerNo}-Renewed`} onClick={onRenew}>Renew</Button>
              <Button size="lg" variant="secondary" loading={busyKey === `${containerNo}-Off-Lease`} onClick={onOffLease}>Off-Lease</Button>
            </div>
          ) : (
            <span className={styles.viewOnlyIcon}>View Only</span>
          )}
        </div>
      </div>
    </div>
  );
}

function formatDays(daysLeft) {
  if (typeof daysLeft !== 'number') return '—';
  if (daysLeft < 0) return `${Math.abs(daysLeft)}d overdue`;
  if (daysLeft === 0) return 'Today';
  return `${daysLeft}d left`;
}
