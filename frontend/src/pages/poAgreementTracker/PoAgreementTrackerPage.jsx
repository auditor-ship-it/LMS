import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader, Card, Button, SearchBar, ErrorState, EmptyState } from '../../components/ui/index.js';
import { SkeletonTable } from '../../components/ui/Skeleton.jsx';
import { useAsync } from '../../hooks/useAsync.js';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import { fetchPoAgreementTracker } from '../../services/poAgreementTracker.service.js';
import { ROUTES } from '../../constants/routes.js';
import styles from './PoAgreementTrackerPage.module.css';

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* Explicit request 2026-10-16 ("only one col green and red only"):
   simplified to just two bands, past-due or not — dropped the "due
   soon"/"upcoming" amber/blue middle tiers Lease Expiry itself still uses,
   since here they read as confusing extra colors rather than useful
   warning. This is a local, page-only simplification — does not touch
   expiry.service.js's own 4-band logic used elsewhere in the app. */
function bandForDate(dateStr, today) {
  if (!dateStr) return null;
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return d < today ? 'overdue' : 'safe';
}

const BAND_TONE = { overdue: 'bad', safe: 'ok' };
// Same 2 bands, but as TEXT color for the Agreement/PO Date columns — the
// dot classes above (.bad/.ok) set background, which would turn a whole
// table cell solid red/green; these set color only.
const BAND_TEXT_TONE = { overdue: 'textBad', safe: 'textOk' };
// Year view's month checkboxes are colored inline (border + fill) rather
// than via CSS class, since a checkbox needs both colors set together.
const BAND_COLOR_VAR = {
  overdue: 'var(--error)',
  safe: 'var(--success)',
  none: 'var(--text-3)'
};

/** "YYYY-MM-DD" -> "DD-MM-YYYY", matching this app's own date display convention elsewhere. */
function formatDisplayDate(dateStr) {
  if (!dateStr) return '—';
  const [y, m, d] = dateStr.split('-');
  return `${d}-${m}-${y}`;
}

/** Month index (0-11) if `dateStr` ("YYYY-MM-DD") falls in the given year, else null. */
function monthOfYear(dateStr, year) {
  if (!dateStr) return null;
  const [y, m] = dateStr.split('-').map(Number);
  return y === year ? m - 1 : null;
}

/**
 * The portion of [startStr, endStr] (inclusive) that falls within the given
 * year, as {from, to} month-index numbers (0-11) — or null if there's no
 * start date, no overlap with this year, or the dates are the wrong way
 * round (seen in real data — a stray reversed Agreement Date entry; treated
 * as untrustworthy rather than drawn as a backwards range). A span that
 * starts before or ends after the displayed year is clipped to Jan / Dec,
 * so it visually continues off either edge.
 */
function coverageMonthsForYear(startStr, endStr, year) {
  if (!startStr || !endStr) return null;
  const start = new Date(`${startStr}T00:00:00`);
  const end = new Date(`${endStr}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return null;
  const yearStart = new Date(year, 0, 1);
  const yearEnd = new Date(year, 11, 31);
  if (end < yearStart || start > yearEnd) return null;
  return {
    from: start < yearStart ? 0 : start.getMonth(),
    to: end > yearEnd ? 11 : end.getMonth()
  };
}

/**
 * The set of month indices (0-11, within `year`) that are "relevant" for
 * one side (Agreement or PO) of the Month-Wise Renew Tracking table —
 * explicit spec 2026-10-16. Every covered month (the start-to-end range,
 * or just the single valid-till month when there's no start date) PLUS
 * every month after that which has LAPSED (valid-till already passed with
 * no renewal filed yet) — mirrors exactly the grid's covered/lapsed split,
 * just returned as a set of months instead of colored cells.
 */
function relevantMonths(range, singleMonth, band) {
  const months = new Set();
  if (range) { for (let m = range.from; m <= range.to; m++) months.add(m); }
  else if (singleMonth !== null) months.add(singleMonth);
  const coveredTo = range ? range.to : singleMonth;
  if (band === 'overdue' && coveredTo !== null) {
    for (let m = coveredTo + 1; m <= 11; m++) months.add(m);
  }
  return months;
}

/**
 * Flattens one container into its Month-Wise Renew Tracking rows — one row
 * per tracking month, per the pasted spec's table (container/client/
 * renewal start+end stay the same on every row; Renewal Status and PO
 * Coverage Status are each independently Green/Red/Pending for that row's
 * month). PENDING overrides a would-be Red month only while the container
 * itself is actively mid-renewal (status === 'Documents Pending') — a
 * genuinely missing PO with no renewal in progress stays Red, per the
 * spec's own distinction ("PENDING... awaiting completion... distinguish
 * it from a confirmed missing PO").
 */
function trackingRowsForContainer(c, displayedYear) {
  const agrBand = bandForDate(c.agreementDate, new Date(new Date().setHours(0, 0, 0, 0)));
  const poBand = bandForDate(c.poDate, new Date(new Date().setHours(0, 0, 0, 0)));
  const agrRange = coverageMonthsForYear(c.agreementStartDate, c.agreementDate, displayedYear);
  const poRange = coverageMonthsForYear(c.agreementDate, c.poDate, displayedYear);
  const agrMonth = monthOfYear(c.agreementDate, displayedYear);
  const poMonth = monthOfYear(c.poDate, displayedYear);
  const agrMonths = relevantMonths(agrRange, agrMonth, agrBand);
  const poMonths = relevantMonths(poRange, poMonth, poBand);
  const isMidRenewal = String(c.status || '').trim().toLowerCase() === 'documents pending';

  const allMonths = [...new Set([...agrMonths, ...poMonths])].sort((a, b) => a - b);
  return allMonths.map((m) => {
    const inAgr = agrRange ? (m >= agrRange.from && m <= agrRange.to) : agrMonth === m;
    const inPo = poRange ? (m >= poRange.from && m <= poRange.to) : poMonth === m;
    const renewalStatus = inAgr ? 'Green' : (agrMonths.has(m) ? (isMidRenewal ? 'Pending' : 'Red') : '—');
    const poCoverageStatus = inPo ? 'Green' : (poMonths.has(m) ? (isMidRenewal ? 'Pending' : 'Red') : '—');
    return {
      key: `${c.container}-${m}`,
      container: c.container,
      clientName: c.clientName,
      renewalStartDate: c.agreementStartDate,
      renewalEndDate: c.agreementDate,
      trackingMonth: `${MONTH_SHORT[m]} ${displayedYear}`,
      renewalStatus,
      poNo: c.poNo,
      poStartDate: c.agreementDate,
      poValidityEndDate: c.poDate,
      poCoverageStatus,
      renewalSubmittedDate: c.renewalSubmittedDate,
      remarks: c.remarks
    };
  });
}

const STATUS_TONE = { Green: 'textOk', Red: 'textBad', Pending: 'textWarn', '—': '' };

/**
 * PO & Agreement Tracker — explicit request 2026-10-16: a year-wide view
 * (Jan..Dec as columns) of every deployed container's Agreement Valid Upto
 * / PO Validity dates, colored by urgency. Backed by
 * GET /dashboard/po-agreement-tracker (dashboard.service.js's
 * getPoAgreementTrackerData, itself reusing getExpiryDataByFilter('pending',
 * null) — the same unscoped "every deployed container" list Lease Expiry's
 * own digest email already uses).
 *
 * Agreement shows a checked box for every month covered by its start date
 * (joined from the "New lease reff" sheet's own Agreement Date column —
 * see _agreementStartDateMap, backend/src/services/expiry.service.js) to
 * its valid-upto date. That start date only exists for containers entered
 * through that sheet (~15% of today's deployed fleet) — a container
 * without one shows no checked months (an empty outline only), same as PO
 * always shows (a single end-date dot): no PO start date is tracked
 * anywhere in this system.
 *
 * Originally shipped with a Day view (one month, by day) alongside this;
 * dropped per explicit follow-up request ("ONLY YEAR VIEW") — Year view is
 * now the only mode.
 */
export function PoAgreementTrackerPage() {
  const { data, loading, error, reload } = useAsync(fetchPoAgreementTracker, []);
  const navigate = useNavigate();
  const [yearOffset, setYearOffset] = useState(0);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 200);
  const [onlyThisYear, setOnlyThisYear] = useState(false);
  // "one PO wise view and one agreement wise view" — explicit request
  // 2026-10-16: the combined grid (Agreement checkbox + PO dot in the same
  // cell) got cluttered/confusing once both started actually showing ticks.
  // Splitting into two toggleable views instead of showing both at once.
  const [dataView, setDataView] = useState('agreement'); // 'agreement' | 'po'
  // Month-Wise Renew Tracking table — explicit pasted spec 2026-10-16: a
  // long one-row-per-tracking-month list (Renewal Status AND PO Coverage
  // Status side by side), alongside the existing month-grid rather than
  // replacing it. Only relevant (covered or lapsed) months get a row, so
  // this doesn't balloon into 12 rows per container.
  const [viewMode, setViewMode] = useState('grid'); // 'grid' | 'table'
  // Explicit request 2026-10-16 ("click the ticket open PO"): clicking a
  // row opens a read-only detail panel in place of the table, same swap-
  // in-place pattern Lease Expiry/Renew & Document already use for their
  // own row detail. No edit form here — this page lists EVERY deployed
  // container, not just ones in the 'Documents Pending' stage that can
  // actually be saved; Edit instead hands off to Renew & Document, which
  // already gates correctly.
  const [selected, setSelected] = useState(null);

  const today = useMemo(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }, []);
  const displayedYear = today.getFullYear() + yearOffset;
  const monthList = useMemo(() => Array.from({ length: 12 }, (_, i) => i), []);

  const containers = data?.containers || [];
  const filtered = useMemo(() => {
    const term = debouncedSearch.trim().toLowerCase();
    let out = containers;
    if (term) out = out.filter((c) => c.container.toLowerCase().includes(term) || c.clientName.toLowerCase().includes(term));
    if (onlyThisYear) {
      out = out.filter((c) => monthOfYear(c.agreementDate, displayedYear) !== null || monthOfYear(c.poDate, displayedYear) !== null);
    }
    return out;
  }, [containers, debouncedSearch, onlyThisYear, displayedYear]);

  // "AGRMENT WISE AND PO WISE" totals — explicit request 2026-10-16: how
  // many of the currently-shown containers have an Agreement date vs a PO
  // date due in the displayed year, counted separately (a container can
  // count toward both, or neither).
  const agreementDueCount = useMemo(
    () => filtered.filter((c) => monthOfYear(c.agreementDate, displayedYear) !== null).length,
    [filtered, displayedYear]
  );
  const poDueCount = useMemo(
    () => filtered.filter((c) => monthOfYear(c.poDate, displayedYear) !== null).length,
    [filtered, displayedYear]
  );

  const trackingRows = useMemo(
    () => (viewMode === 'table' ? filtered.flatMap((c) => trackingRowsForContainer(c, displayedYear)) : []),
    [filtered, displayedYear, viewMode]
  );

  return (
    <>
      <PageHeader
        title="PO & Agreement Tracker"
        subtitle="Agreement and PO validity dates across every deployed container"
        actions={<Button variant="secondary" size="sm" onClick={reload}>Refresh</Button>}
      />
      <Card>
        <div className={styles.toolbar}>
          <SearchBar value={search} onChange={setSearch} placeholder="Search container, client…" />
          <div className={styles.viewToggle}>
            <button type="button" className={viewMode === 'grid' ? styles.viewBtnActive : styles.viewBtn} onClick={() => setViewMode('grid')}>Grid view</button>
            <button type="button" className={viewMode === 'table' ? styles.viewBtnActive : styles.viewBtn} onClick={() => setViewMode('table')}>Table view</button>
          </div>
          {viewMode === 'grid' && (
            <div className={styles.viewToggle}>
              <button type="button" className={dataView === 'agreement' ? styles.viewBtnActive : styles.viewBtn} onClick={() => setDataView('agreement')}>Agreement wise</button>
              <button type="button" className={dataView === 'po' ? styles.viewBtnActive : styles.viewBtn} onClick={() => setDataView('po')}>PO wise</button>
            </div>
          )}
          <label className={styles.checkboxLabel}>
            <input type="checkbox" checked={onlyThisYear} onChange={(e) => setOnlyThisYear(e.target.checked)} />
            Only show containers due this year
          </label>
          <div className={styles.monthNav}>
            <button type="button" className={styles.navBtn} onClick={() => setYearOffset((y) => y - 1)} aria-label="Previous year">‹</button>
            <span className={styles.monthLabel}>{displayedYear}</span>
            <button type="button" className={styles.navBtn} onClick={() => setYearOffset((y) => y + 1)} aria-label="Next year">›</button>
            {yearOffset !== 0 && <button type="button" className={styles.todayBtn} onClick={() => setYearOffset(0)}>This year</button>}
          </div>
        </div>

        {!error && !loading && !!filtered.length && !selected && (
          <div className={styles.totals}>
            <span><strong>{agreementDueCount}</strong> agreement{agreementDueCount === 1 ? '' : 's'} due in {displayedYear}</span>
            <span><strong>{poDueCount}</strong> PO{poDueCount === 1 ? '' : 's'} due in {displayedYear}</span>
          </div>
        )}

        {error && <ErrorState message={error} onRetry={reload} />}
        {!error && loading && <SkeletonTable columns={6} rows={10} />}
        {!error && !loading && !filtered.length && <EmptyState message="No containers found" />}
        {!error && !loading && filtered.length > 0 && selected && (
          <PoAgreementDetail container={selected} onBack={() => setSelected(null)} onEdit={() => navigate(ROUTES.RENEW_DOCUMENT, { state: { focusContainer: selected.container } })} />
        )}
        {!error && !loading && filtered.length > 0 && !selected && viewMode === 'table' && (
          <div className={styles.scrollWrap}>
            {!trackingRows.length
              ? <EmptyState message="No container has a renewal or PO due/lapsed in this year" />
              : (
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th className={styles.colContainer}>Container</th>
                      <th className={styles.colClient}>Client</th>
                      <th className={styles.colDate}>Renewal Start</th>
                      <th className={styles.colDate}>Renewal End</th>
                      <th>Tracking Month</th>
                      <th>Renewal Status</th>
                      <th>PO No</th>
                      <th className={styles.colDate}>PO Start</th>
                      <th className={styles.colDate}>PO Valid Till</th>
                      <th>PO Coverage Status</th>
                      <th>Entry Date</th>
                      <th>Remarks</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trackingRows.map((r) => (
                      <tr key={r.key} className={styles.clickRow} onClick={() => setSelected(containers.find((c) => c.container === r.container))}>
                        <td className={styles.colContainer}>{r.container}</td>
                        <td className={styles.colClient}>{r.clientName}</td>
                        <td className={styles.colDate}>{r.renewalStartDate ? formatDisplayDate(r.renewalStartDate) : '—'}</td>
                        <td className={styles.colDate}>{formatDisplayDate(r.renewalEndDate)}</td>
                        <td>{r.trackingMonth}</td>
                        <td className={styles[STATUS_TONE[r.renewalStatus]]}>{r.renewalStatus}</td>
                        <td>{r.poNo || '—'}</td>
                        <td className={styles.colDate}>{r.poStartDate ? formatDisplayDate(r.poStartDate) : '—'}</td>
                        <td className={styles.colDate}>{formatDisplayDate(r.poValidityEndDate)}</td>
                        <td className={styles[STATUS_TONE[r.poCoverageStatus]]}>{r.poCoverageStatus}</td>
                        <td>{r.renewalSubmittedDate || '—'}</td>
                        <td>{r.remarks || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
          </div>
        )}
        {!error && !loading && filtered.length > 0 && !selected && viewMode === 'grid' && (
          <div className={styles.scrollWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.colContainer}>Container</th>
                  <th className={styles.colClient}>Client</th>
                  <th className={styles.colDate}>Agreement Date</th>
                  <th className={styles.colDate}>PO Date</th>
                  {monthList.map((m) => (
                    <th key={m} className={displayedYear === today.getFullYear() && m === today.getMonth() ? styles.todayCol : undefined}>{MONTH_SHORT[m]}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((c) => {
                  const agrBand = bandForDate(c.agreementDate, today);
                  const poBand = bandForDate(c.poDate, today);
                  const poMonth = monthOfYear(c.poDate, displayedYear);
                  const agrMonth = monthOfYear(c.agreementDate, displayedYear);
                  const agrRange = coverageMonthsForYear(c.agreementStartDate, c.agreementDate, displayedYear);
                  // PO has no start date of its own anywhere in this system —
                  // explicit request/example 2026-10-16 (container CXRU1249797:
                  // Agreement Aug->Sep, PO valid Oct -> Sep+Oct should both
                  // tick): a PO's coverage is treated as picking up right where
                  // the Agreement's own valid-till date leaves off, so it gets a
                  // real range whenever an Agreement end date exists, not just a
                  // single tick.
                  const poRange = coverageMonthsForYear(c.agreementDate, c.poDate, displayedYear);
                  const band = dataView === 'po' ? poBand : agrBand;
                  const toneVar = BAND_COLOR_VAR[band] || BAND_COLOR_VAR.none;
                  const range = dataView === 'po' ? poRange : agrRange;
                  const singleMonth = dataView === 'po' ? poMonth : agrMonth;
                  // Explicit example 2026-10-16: "jan feb march po valid [green],
                  // then april not update renew this month red, but after the
                  // update green" — once covered.valid-till has actually LAPSED
                  // (band === 'overdue', i.e. today is past it with no renewal
                  // filed yet), every month after the last covered one stays
                  // flagged solid red for the rest of the year, not just left
                  // blank — a blank box reads as "nothing due here", but the
                  // real state is "overdue, still unrenewed". The moment a real
                  // Update Agreement/PO pushes the valid-till date forward, this
                  // whole row turns 'safe' and these same months go green instead
                  // (covered, ticked) the next time this data is fetched.
                  const coveredToMonth = range ? range.to : singleMonth;
                  return (
                    <tr key={c.container} className={styles.clickRow} onClick={() => setSelected(c)}>
                      <td className={styles.colContainer}>{c.container}</td>
                      <td className={styles.colClient}>{c.clientName}</td>
                      <td className={`${styles.colDate} ${agrBand ? styles[BAND_TEXT_TONE[agrBand]] : ''}`}>{formatDisplayDate(c.agreementDate)}</td>
                      <td className={`${styles.colDate} ${poBand ? styles[BAND_TEXT_TONE[poBand]] : ''}`}>{formatDisplayDate(c.poDate)}</td>
                      {monthList.map((m) => {
                        // Agreement view: checked for every month the start-to-
                        // valid-till range covers — but MOST containers have no
                        // start date on file, so agrRange is null for most rows;
                        // those tick just their valid-till month instead.
                        // PO view: ticks the Agreement-end-to-PO-end range when
                        // both dates exist, else just the single PO valid-till
                        // month (no Agreement date to pick up coverage from).
                        const inRange = range ? (m >= range.from && m <= range.to) : singleMonth === m;
                        const lapsed = !inRange && band === 'overdue' && coveredToMonth !== null && m > coveredToMonth;
                        const label = dataView === 'po' ? 'PO' : 'Agreement';
                        const title = inRange
                          ? (range ? `${label} covers ${dataView === 'po' ? c.agreementDate : c.agreementStartDate} to ${dataView === 'po' ? c.poDate : c.agreementDate}` : `${label} valid upto ${dataView === 'po' ? c.poDate : c.agreementDate}`)
                          : (lapsed ? `${label} overdue since ${dataView === 'po' ? c.poDate : c.agreementDate} — not yet renewed` : undefined);
                        return (
                          <td
                            key={m}
                            className={`${styles.dayCell} ${displayedYear === today.getFullYear() && m === today.getMonth() ? styles.todayCol : ''}`}
                            title={title}
                          >
                            <span
                              className={`${styles.checkbox} ${(inRange || lapsed) ? styles.checkboxChecked : ''}`}
                              style={{ borderColor: toneVar, background: (inRange || lapsed) ? toneVar : 'transparent' }}
                            >
                              {inRange && '✓'}
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {!selected && viewMode === 'grid' && <div className={styles.legend}>
          <span className={styles.legendItem}><span className={`${styles.dot} ${styles.bad}`} />Overdue</span>
          <span className={styles.legendItem}><span className={`${styles.dot} ${styles.ok}`} />Safe</span>
          <span className={styles.legendItem}><span className={`${styles.checkbox} ${styles.bad}`} style={{ borderColor: 'var(--error)' }} />Solid red, no tick = overdue, still not renewed</span>
          <span className={styles.legendDivider} />
          {dataView === 'po' ? (
            <span className={styles.legendItem}><span className={styles.checkbox} style={{ borderColor: 'var(--text-3)' }} />PO (checked = covered month, Agreement's own valid-upto date to PO valid-upto — just the valid-upto month ticked if no Agreement date exists)</span>
          ) : (
            <span className={styles.legendItem}><span className={styles.checkbox} style={{ borderColor: 'var(--text-3)' }} />Agreement (checked = covered month, start date to valid-upto where a start date is on file — just the valid-upto month ticked otherwise)</span>
          )}
        </div>}
      </Card>
    </>
  );
}

/**
 * Read-only detail panel for one container, shown when a tracker row is
 * clicked ("click the ticket open PO" — explicit request 2026-10-16). Pure
 * display — this page covers every deployed container, most of which
 * aren't in the 'Documents Pending' stage its Update Agreement form can
 * actually save to, so editing happens by handing off to Renew & Document
 * (onEdit) instead of reimplementing that form here.
 */
function PoAgreementDetail({ container: c, onBack, onEdit }) {
  const today = useMemo(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }, []);
  const agrBand = bandForDate(c.agreementDate, today);
  const poBand = bandForDate(c.poDate, today);
  const editable = String(c.status || '').trim().toLowerCase() === 'documents pending';

  return (
    <div className={styles.detailPanel}>
      <div className={styles.detailHeader}>
        <h3>{c.container}</h3>
        <span>{c.clientName}</span>
      </div>

      {c.provisional && (
        <p className={styles.hintText}>
          Based on a renewal already submitted but not yet approved by Pushpa — dates may still change.
        </p>
      )}

      <div className={styles.detailGrid}>
        <div className={styles.detailField}>
          <span className={styles.label}>Agreement Valid Till</span>
          <span className={agrBand ? styles[BAND_TEXT_TONE[agrBand]] : ''}>{formatDisplayDate(c.agreementDate)}</span>
        </div>
        <div className={styles.detailField}>
          <span className={styles.label}>Agreement Start Date</span>
          <span>{c.agreementStartDate ? formatDisplayDate(c.agreementStartDate) : '— (not on file)'}</span>
        </div>
        <div className={styles.detailField}>
          <span className={styles.label}>Agreement File</span>
          {c.agreementUrl
            ? <a href={c.agreementUrl} target="_blank" rel="noreferrer">Open Agreement ↗</a>
            : <span className={styles.hintText}>No agreement file on record</span>}
        </div>

        <div className={styles.detailField}>
          <span className={styles.label}>PO Valid Till</span>
          <span className={poBand ? styles[BAND_TEXT_TONE[poBand]] : ''}>{formatDisplayDate(c.poDate)}</span>
        </div>
        <div className={styles.detailField}>
          <span className={styles.label}>PO No</span>
          <span>{c.poNo || '—'}</span>
        </div>
        <div className={styles.detailField}>
          <span className={styles.label}>PO File</span>
          {c.poPdfUrl
            ? <a href={c.poPdfUrl} target="_blank" rel="noreferrer">Open PO ↗</a>
            : <span className={styles.hintText}>No PO file on record</span>}
        </div>

        {c.billingCycle && (
          <div className={styles.detailField}>
            <span className={styles.label}>Billing Cycle</span>
            <span>{c.billingCycle}</span>
          </div>
        )}
        <div className={styles.detailField}>
          <span className={styles.label}>Renewal Status</span>
          <span>{c.status || 'No renewal in progress'}</span>
        </div>
      </div>

      <div className={styles.detailActions}>
        <Button variant="secondary" onClick={onBack}>Back to list</Button>
        {editable && <Button variant="primary" onClick={onEdit}>Edit in Renew &amp; Document →</Button>}
      </div>
    </div>
  );
}
