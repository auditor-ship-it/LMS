import { useEffect, useMemo, useState } from 'react';
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
import { OffLeaseModal } from './OffLeaseModal.jsx';
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
  const { data, loading, error, reload } = useAsync(() => fetchExpiryList(), []);
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

  /* Bulk selection, keyed by _idx — see the comment on `rows` above for why
     container number can't be the key here (the same container can
     legitimately appear more than once). Cleared whenever the underlying
     list reloads for ANY reason (manual refresh, the cross-page
     'deployed-sheet' auto-refresh, or a bulk action's own post-write
     reload) — _idx is only stable within one load, so carrying a selection
     across a reload risks it silently pointing at different rows once
     positions shift. */
  const [selectedKeys, setSelectedKeys] = useState(() => new Set());
  const [bulkBusy, setBulkBusy] = useState('');
  useEffect(() => { setSelectedKeys(new Set()); }, [data]);

  /* Off-Lease confirmation — OffLeaseModal.jsx, mirroring RejectModal's
     item/items mutually-exclusive convention (Approval queue) and Stage 1's
     own HoldModal. offLeaseItem/offLeaseItems null = closed. */
  const [offLeaseItem, setOffLeaseItem] = useState(null);
  const [offLeaseItems, setOffLeaseItems] = useState(null);
  const [offLeaseBusy, setOffLeaseBusy] = useState(false);
  const [offLeaseError, setOffLeaseError] = useState('');
  const closeOffLease = () => { setOffLeaseItem(null); setOffLeaseItems(null); setOffLeaseError(''); };

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

  // Derived from `filtered`, not just the current page, so a selection made
  // on page 1 survives navigating to page 2.
  const selectedItems = useMemo(
    () => filtered.filter((r) => selectedKeys.has(r._idx)),
    [filtered, selectedKeys]
  );
  const toggleRow = (key) => setSelectedKeys((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const toggleAllOnPage = () => setSelectedKeys((prev) => {
    const pageKeys = pageRows.map((r) => r._idx);
    const allSelected = pageKeys.length > 0 && pageKeys.every((k) => prev.has(k));
    const next = new Set(prev);
    pageKeys.forEach((k) => (allSelected ? next.delete(k) : next.add(k)));
    return next;
  });

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
      // item._rowNum: this exact Deployed row, not just the container number
      // — see saveExpiryAction's doc comment for why that distinction matters.
      const result = await actionExpiryRow(containerNo, new Date().toISOString(), status, item._rowNum);
      if (result === 'ALREADY_PROCESSED') {
        setActionError(`${containerNo} was already actioned by someone else.`);
      }
      setSelectedIdx(null);
      // ONE rule, deliberately: write, then read. The write above already
      // completed against the live sheet, so a read taken strictly after it
      // is authoritative — no optimistic local patch to keep in sync, no
      // second background fetch racing it. Confirmed 2026-08-21: running an
      // optimistic patch AND a self-triggered background reload side by
      // side let the (slower, real Sheets-latency) reload silently
      // overwrite the already-correct optimistic state a moment later — a
      // visible "chip flashes in, then vanishes" bug. awaiting this reload
      // before invalidate() also means OTHER pages' own reloads (triggered
      // below) start after this one has already landed, not racing it.
      await reload();
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
  //
  // Goes through OffLeaseModal (Person Name + optional Remarks) rather than
  // acting instantly on click — same "confirm with a couple of fields
  // first" shape as Stage 1's Hold and Stage 1A's Reject, both built this
  // session. handleOffLeaseSubmit below does the actual write, for both the
  // single-row (offLeaseItem) and bulk (offLeaseItems) case.
  const handleOffLeaseSubmit = async ({ personName, remarks }) => {
    setOffLeaseBusy(true);
    setOffLeaseError('');
    try {
      if (offLeaseItems) {
        const containers = offLeaseItems.map((it) => it.row?.[0]);
        const results = await Promise.allSettled(
          offLeaseItems.map((it) => trackContainer(it.row?.[0], it._rowNum, remarks, personName))
        );
        const alreadyExists = results
          .map((r, i) => (r.status === 'fulfilled' && r.value === 'ALREADY_EXISTS' ? containers[i] : null))
          .filter(Boolean);
        const failed = results
          .map((r, i) => (r.status === 'rejected' ? containers[i] : null))
          .filter(Boolean);
        const notes = [];
        if (alreadyExists.length) notes.push(`Already in Off-Lease tracking: ${alreadyExists.join(', ')}.`);
        if (failed.length) notes.push(`Failed: ${failed.join(', ')}.`);
        if (notes.length) setActionError(notes.join(' '));
      } else if (offLeaseItem) {
        const containerNo = offLeaseItem.row?.[0];
        // offLeaseItem._rowNum: this exact Deployed row, not just the
        // container number — see trackContainer's doc comment for why that
        // distinction matters.
        const result = await trackContainer(containerNo, offLeaseItem._rowNum, remarks, personName);
        if (result === 'ALREADY_EXISTS') setActionError(`${containerNo} is already in Off-Lease tracking.`);
        setSelectedIdx(null);
      }
      closeOffLease();
      // Write, then read — see runAction's identical note above.
      await reload();
      invalidate('deployed-sheet');
    } catch (e) {
      setOffLeaseError(apiErrorMessage(e));
    } finally {
      setOffLeaseBusy(false);
    }
  };

  /* Bulk versions of the two actions above — run in parallel (independent
     writes to different rows), one write each, no shared form data to
     collect first, so there's no modal: click, confirm the count, done. A
     per-container failure is reported by container number rather than
     failing the whole batch silently. */
  const handleBulkAction = async (status) => {
    if (!selectedItems.length) return;
    const containers = selectedItems.map((it) => it.row?.[0]);
    setBulkBusy(status);
    setActionError('');
    try {
      const results = await Promise.allSettled(
        selectedItems.map((it) => actionExpiryRow(it.row?.[0], new Date().toISOString(), status, it._rowNum))
      );
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
      invalidate('deployed-sheet');
    } catch (e) {
      setActionError(apiErrorMessage(e));
    } finally {
      setBulkBusy('');
    }
  };

  const handleBulkOffLease = () => {
    if (!selectedItems.length) return;
    setOffLeaseError('');
    setOffLeaseItems(selectedItems);
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

            {canActExpiry && selectedItems.length > 0 && (
              <div className={styles.bulkBar}>
                <span className={styles.bulkCount}>{selectedItems.length} selected</span>
                <Button size="sm" variant="secondary" onClick={() => setSelectedKeys(new Set())}>Clear</Button>
                <Button size="sm" variant="primary" loading={bulkBusy === 'Renewed'} disabled={!!bulkBusy} onClick={() => handleBulkAction('Renewed')}>
                  Renew ({selectedItems.length})
                </Button>
                <Button size="sm" variant="secondary" disabled={!!bulkBusy} onClick={handleBulkOffLease}>
                  Off-Lease ({selectedItems.length})
                </Button>
              </div>
            )}

            <DataGrid
              className={styles.wrapTable}
              headers={[...tableHeaders, 'Ageing', 'Days Left', 'Renewal Status']}
              rows={pageRows}
              rowKey={(r) => r._idx}
              loading={loading}
              error={error}
              onRetry={reload}
              selectable={canActExpiry}
              selectedKeys={selectedKeys}
              onToggleRow={toggleRow}
              onToggleAll={toggleAllOnPage}
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
            onOffLease={() => { setOffLeaseError(''); setOffLeaseItem(selected); }}
          />
        )}
      </Card>

      <OffLeaseModal
        open={!!(offLeaseItem || offLeaseItems)}
        item={offLeaseItem}
        items={offLeaseItems}
        submitting={offLeaseBusy}
        error={offLeaseError}
        onClose={closeOffLease}
        onSubmit={handleOffLeaseSubmit}
      />
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
  // Renew only needs to be offered once the lease is actually approaching —
  // a container freshly renewed for another year+ has nothing to act on
  // yet. Reappears on its own once daysLeft (the sooner of Agreement Valid
  // Upto / PO Validity — see getExpiryDataByFilter's Math.min) drops to 15
  // or below, same threshold whether this is its first renewal or its
  // fifth. `daysLeft == null` (neither date on record) still shows it —
  // nothing to compute a window from, so the old "always available" default
  // applies rather than hiding it with no way back.
  const dueSoon = item.daysLeft == null || item.daysLeft <= 15;
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
              ) : dueSoon ? (
                <Button size="lg" variant="primary" loading={busyKey === `${containerNo}-Renewed`} onClick={onRenew}>Renew</Button>
              ) : (
                <span className={styles.viewOnlyIcon}>Not due yet — Renew reappears within 15 days of expiry ({formatDays(item.daysLeft)} left)</span>
              )}
              <Button size="lg" variant="secondary" onClick={onOffLease}>Off-Lease</Button>
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
