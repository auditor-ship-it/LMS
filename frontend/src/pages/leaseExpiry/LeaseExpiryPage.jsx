import { useMemo, useState } from 'react';
import {
  PageHeader, Card, Button, StatusBadge, SearchBar, FilterBar, Pagination, DataGrid, StatCard, renderCellValue
} from '../../components/ui/index.js';
import { useAsync } from '../../hooks/useAsync.js';
import { usePagination } from '../../hooks/usePagination.js';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import { usePermission } from '../../hooks/usePermission.js';
import { useAutoRefresh } from '../../hooks/useAutoRefresh.js';
import { invalidate } from '../../shared/dataBus.js';
import { apiErrorMessage } from '../../shared/auth/index.js';
import { fetchExpiryList, actionExpiryRow, syncSalePersons } from '../../services/expiry.service.js';
import { trackContainer } from '../../services/offLease.service.js';
import { isRateOrAmountHeader } from '../../utils/isRateOrAmountHeader.js';
import { distinctOptionsForColumn } from '../../utils/tableFilters.js';
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
  const { data, loading, error, reload, setData } = useAsync(() => fetchExpiryList(), []);
  // Renew & Document reads the same Deployed-sheet columns this page's
  // Renew/Off-Lease actions write — without this, switching to that page
  // after an action here would still show whatever it last had cached
  // (KeepAlivePages keeps every visited page mounted and only fetches once).
  useAutoRefresh('deployed-sheet', reload);
  const { canAct } = usePermission();
  const canActExpiry = canAct('expiry');

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 250);
  const [band, setBand] = useState('');
  const [salePerson, setSalePerson] = useState('');
  const [busyKey, setBusyKey] = useState('');
  const [actionError, setActionError] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState('');

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

  /* Located by header text, not a fixed index -- "Sale Person" is a
     CRM-resolved column expiry.service.js adds to the displayed headers,
     not a fixed position in the underlying sheet. */
  const salePersonColIdx = useMemo(
    () => headers.findIndex((h) => /^sale person$/i.test(String(h || '').trim())),
    [headers]
  );
  const salePersonOptions = useMemo(
    () => distinctOptionsForColumn(rows, salePersonColIdx),
    [rows, salePersonColIdx]
  );

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
    if (salePerson && salePersonColIdx >= 0) {
      list = list.filter((r) => String((r.row || [])[salePersonColIdx] ?? '').trim() === salePerson);
    }
    if (band === 'upcoming') list = list.filter((r) => r.band !== 'overdue');
    else if (band.startsWith('overdue-')) {
      const bucket = band.slice('overdue-'.length);
      list = list.filter((r) => r.band === 'overdue' && overdueMagnitudeBucket(r) === bucket);
    } else if (band) list = list.filter((r) => r.band === band);
    const term = debouncedSearch.trim().toLowerCase();
    if (term) list = list.filter((r) => (r.row || []).some((v) => String(v ?? '').toLowerCase().includes(term)));
    return list;
  }, [rows, band, salePerson, salePersonColIdx, debouncedSearch]);

  const { page, totalPages, pageRows, setPage, nextPage, prevPage, resetPage } = usePagination(filtered, 10);

  const selected = selectedIdx != null ? filtered.find((it) => it._idx === selectedIdx) : null;

  const handleSearchChange = (v) => { setSearch(v); resetPage(); };
  const handleBandChange = (v) => { setBand(v); resetPage(); };
  const handleSalePersonChange = (v) => { setSalePerson(v); resetPage(); };

  /* "Sale Person" is not this sheet's own column any more — it is resolved
     live from the Sales CRM, which the server caches for 30 minutes. This
     button skips that wait: it makes the server re-read the CRM collection
     now and re-fetches the list, so a company reassigned moments ago shows
     its new owner immediately. It only ever READS the CRM — reassignment
     happens in the Sales CRM and nowhere else. */
  const handleSyncSalePersons = async () => {
    setSyncing(true);
    setSyncNote('');
    setActionError('');
    try {
      const res = await syncSalePersons();
      await reload();
      const at = new Date(res?.syncedAt || Date.now()).toLocaleTimeString();
      setSyncNote(`Sale Person updated from the Sales CRM — ${res?.companies ?? 0} companies, synced ${at}.`);
    } catch (e) {
      setActionError(apiErrorMessage(e));
    } finally {
      setSyncing(false);
    }
  };

  const runAction = async (item, status) => {
    const containerNo = item.row?.[0];
    const key = `${containerNo}-${status}`;
    setBusyKey(key);
    setActionError('');
    try {
      const result = await actionExpiryRow(containerNo, new Date().toISOString(), status);
      if (result === 'ALREADY_PROCESSED') {
        setActionError(`${containerNo} was already actioned by someone else.`);
      } else {
        // Patch the row locally with what we already know just happened —
        // the write already succeeded against the live sheet (Sheets-first
        // app-wide as of 2026-08-21), so this optimistic patch is already
        // fully correct. Deliberately NOT followed by an immediate reload()
        // on this page: DataGrid's loading state swaps the whole table body
        // for a skeleton, which would hide this already-correct row behind
        // a 1-4s skeleton flash (a real Sheets round trip, no longer the
        // sub-second Mongo read this used to be) for no benefit. Other
        // pages still catch up via invalidate() below, in the background,
        // at their own pace.
        setData((prev) => (prev?.data ? {
          ...prev,
          data: prev.data.map((r) => (r.row?.[0] === containerNo ? { ...r, actionStatus: status } : r))
        } : prev));
      }
      setSelectedIdx(null);
      invalidate('deployed-sheet');
    } catch (e) {
      setActionError(apiErrorMessage(e));
    } finally {
      setBusyKey('');
    }
  };

  // Off-Lease is its own workflow (Off-Lease Tracking sheet, 8 stages) — not
  // a plain status flag on this sheet. This must call the same function the
  // Off-Lease page itself uses to add a container, which both creates the
  // tracking row AND marks Deployed sheet Off-Lease in one step; calling the
  // generic runAction here only did the second half, so the container never
  // actually entered the tracking workflow (confirmed 2026-08-08, GESU6329868).
  const runOffLease = async (item) => {
    const containerNo = item.row?.[0];
    const key = `${containerNo}-Off-Lease`;
    setBusyKey(key);
    setActionError('');
    try {
      const result = await trackContainer(containerNo);
      if (result === 'ALREADY_EXISTS') setActionError(`${containerNo} is already in Off-Lease tracking.`);
      setSelectedIdx(null);
      reload();
      invalidate('deployed-sheet');
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
        actions={
          <>
            <Button variant="secondary" size="sm" loading={syncing} onClick={handleSyncSalePersons}>
              Sync Sale Person
            </Button>
            <Button variant="secondary" size="sm" onClick={reload}>Refresh</Button>
          </>
        }
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
        {syncNote && <p className={styles.syncNote}>{syncNote}</p>}

        {!selected ? (
          <>
            <div className={styles.toolbar}>
              <SearchBar value={search} onChange={handleSearchChange} placeholder="Search container, client…" />
              <FilterBar
                filters={[
                  { key: 'band', label: 'Ageing', options: BAND_OPTIONS, value: band, onChange: handleBandChange },
                  ...(salePersonColIdx >= 0 && salePersonOptions.length
                    ? [{ key: 'salePerson', label: 'Sale Person', options: salePersonOptions, value: salePerson, onChange: handleSalePersonChange }]
                    : [])
                ]}
              />
            </div>

            <DataGrid
              className={styles.wrapTable}
              headers={[...tableHeaders, 'Ageing', 'Days Left', 'Renewal Status']}
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
                </td>,
                <td key="renewalStatus" className={styles.clickCell} onClick={() => setSelectedIdx(item._idx)}>
                  {item.actionStatus ? <StatusBadge status={item.actionStatus} /> : '—'}
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
            onOffLease={() => runOffLease(selected)}
          />
        )}
      </Card>
    </>
  );
}

function LeaseExpiryDetail({ item, headers, visibleColIdx, total, canAct, busyKey, onBack, onRenew, onOffLease }) {
  const containerNo = item.row?.[0];
  // Once Renew has been clicked, this container stays here (it can be
  // renewed again in future) but is already in progress on Renew & Document
  // — re-clicking Renew would just bounce off the backend's ALREADY_PROCESSED
  // guard, so swap the button for a status note instead of leaving a
  // confusing dead-end action visible.
  const inProgress = !!item.actionStatus;
  return (
    <div>
      <Button variant="secondary" size="sm" onClick={onBack} className={styles.backBtn}>← Back to List ({total})</Button>

      <div className={styles.detailCard}>
        <div className={styles.detailHeader}>
          <div>
            <h4 className={styles.detailTitle}>{containerNo}</h4>
          </div>
          <div className={styles.actionsCell}>
            {inProgress && <StatusBadge status={item.actionStatus} />}
            <StatusBadge status={BAND_LABEL[item.band] || '—'} />
          </div>
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
              {inProgress ? (
                <span className={styles.viewOnlyIcon}>Sent for renewal — continue from Renew &amp; Document</span>
              ) : (
                <Button size="lg" variant="primary" loading={busyKey === `${containerNo}-Renewed`} onClick={onRenew}>Renew</Button>
              )}
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
