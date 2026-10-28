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

/* Explicit request 2026-10-16 ("only one col green and red only"): dropped
   to two bands at the time. Explicit request 2026-10-23 ("vaild date 30
   daye before this row is grey remondi gaye its one month for vaild
   expeiry noti fire"): brought back a middle "due soon" tier — a date
   within 30 days (inclusive) of today, not yet overdue — so a row can be
   flagged as a reminder BEFORE it actually lapses, not just after. Same
   day, immediate follow-up ("due date yah bhi grey ho jaye not red...
   due date gery ho jaye not red col"): overdue now gets the SAME grey/amber
   treatment as due-soon, not red — red is dropped from this page entirely,
   only Safe stays green. `overdue` and `dueSoon` are kept as distinct band
   values (still useful internally — e.g. a future tooltip/sort), just
   styled identically now. Local, page-only — does not touch
   expiry.service.js's own 4-band logic used elsewhere. */
function bandForDate(dateStr, today) {
  if (!dateStr) return null;
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  if (d < today) return 'overdue';
  const daysLeft = Math.round((d - today) / 86400000);
  return daysLeft <= 30 ? 'dueSoon' : 'safe';
}

// As TEXT color for the Agreement/PO Date columns only. No red on this page
// anymore (explicit request 2026-10-23) — overdue and due-soon both show
// the same amber/warn tone, only Safe is green. The month checkboxes
// themselves don't use this (see BAND_COLOR_VAR's own comment below).
const BAND_TEXT_TONE = { overdue: 'textWarn', dueSoon: 'textWarn', safe: 'textOk' };
// Explicit, repeated request 2026-10-19 ("red chcek box nahi chahiye...
// bas red kuch nahi"): the month checkboxes are just green (covered) or
// blank (not) now — no more red for an overdue/lapsed month. Colored
// inline (border + fill) rather than via CSS class, since a checkbox
// needs both colors set together.
const BAND_COLOR_VAR = {
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
 * Resolves the final checkbox coverage range for ONE date (Agreement or PO)
 * on one container, as a single {from, to} month-index range (or null for
 * no coverage at all). Lacking a real Agreement Start Date on file (most
 * containers), this went through several reversals on 2026-10-23 before
 * landing on a rule confirmed against two concrete, contradictory-looking
 * examples in the same sitting:
 *
 *   - TRIU6680016 (deployed 13-12-2021, valid till 31-03-2026, ALREADY
 *     OVERDUE as of today): confirmed answer "deploy date through March" —
 *     a RANGE, Jan (or deploy month, if later) through the valid-till
 *     month.
 *   - CICU8118167 (deployed 01-04-2018, valid till 31-12-2026, NOT YET
 *     DUE): confirmed answer "only December" — a single month, no range at
 *     all, Jan-Nov all blank.
 *
 * The difference is `band` (overdue vs. not): once a date is overdue, a
 * Jan-start range is read as "this has been sitting unrenewed all year" —
 * informative. For a date not yet due, there's no real evidence of
 * coverage before the end date (no start date on file, remember), so
 * inventing one is just wrong — a single dot at the real date is all
 * that's actually known.
 *
 * Still clamped so it never starts before the container's own Deployed
 * Date — explicit request 2026-10-23 ("deployed date alag hai, april mein
 * hai tho jan to mar checkbox nahi aana chahiye"): a month before the
 * container was even deployed must never show as covered, regardless of
 * what an Agreement Start Date on file says, or whether overdue.
 *
 * An "extend ticks through the current month once overdue" (i.e. past the
 * real valid-till date) was ALSO tried and reverted the same day — verified
 * against APRU5091041 and TRIU6618581: a date's own real range/end is
 * correct and should never be padded PAST it just because the container
 * hasn't been off-leased yet. Do not re-add that.
 */
function resolveCoverageRange({ startStr, endStr, band, deployedDate, year }) {
  const raw = coverageMonthsForYear(startStr, endStr, year);
  let range = raw;
  if (!range) {
    const singleMonth = monthOfYear(endStr, year);
    if (singleMonth !== null) {
      range = band === 'overdue' ? { from: 0, to: singleMonth } : { from: singleMonth, to: singleMonth };
    }
  }

  if (range && deployedDate) {
    const [dy, dm] = deployedDate.split('-').map(Number);
    if (dy > year) range = null; // not deployed yet as of this year at all
    else if (dy === year) {
      const deployMonth = dm - 1;
      range = deployMonth > range.to ? null : { from: Math.max(range.from, deployMonth), to: range.to };
    }
  }

  return range;
}

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
    // Explicit request 2026-10-19 ("do not show this", pointing at rows
    // with no PO Date at all) — a container with no date on record for
    // the view you're actually looking at (Agreement wise needs an
    // Agreement Date, PO wise needs a PO Date) is just noise there, not a
    // real "nothing due" case. Hidden instead of shown as an empty/blank
    // row. Still reachable from the OTHER view if it has data there.
    out = out.filter((c) => (dataView === 'po' ? c.poDate : c.agreementDate));
    if (onlyThisYear) {
      out = out.filter((c) => monthOfYear(c.agreementDate, displayedYear) !== null || monthOfYear(c.poDate, displayedYear) !== null);
    }
    return out;
  }, [containers, debouncedSearch, onlyThisYear, displayedYear, dataView]);

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
            <button type="button" className={dataView === 'agreement' ? styles.viewBtnActive : styles.viewBtn} onClick={() => setDataView('agreement')}>Agreement wise</button>
            <button type="button" className={dataView === 'po' ? styles.viewBtnActive : styles.viewBtn} onClick={() => setDataView('po')}>PO wise</button>
          </div>
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

        {!selected && <div className={styles.legend}>
          <span className={styles.legendItem}><span className={`${styles.dot} ${styles.warn}`} />Overdue or due within 30 days (row highlighted)</span>
          <span className={styles.legendItem}><span className={`${styles.dot} ${styles.ok}`} />Safe</span>
          <span className={styles.legendDivider} />
          {/* Explicit, repeated request 2026-10-19: no red checkbox state
              anymore — just green (covered) or blank (not). The two dots
              above are for the Agreement/PO Date TEXT columns only, which
              still show red/green. */}
          {/* Updated 2026-10-23 to match resolveCoverageRange's own doc
              comment — keep these in sync. */}
          {dataView === 'po' ? (
            <span className={styles.legendItem}><span className={styles.checkbox} style={{ borderColor: 'var(--text-3)' }} />PO (checked = covered month, Agreement's own start date to PO valid-upto when on file — otherwise just the valid-upto month, or Jan through valid-upto if already overdue)</span>
          ) : (
            <span className={styles.legendItem}><span className={styles.checkbox} style={{ borderColor: 'var(--text-3)' }} />Agreement (checked = covered month, start date to valid-upto when on file — otherwise just the valid-upto month, or Jan through valid-upto if already overdue)</span>
          )}
        </div>}

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
        {!error && !loading && filtered.length > 0 && !selected && (
          <div className={styles.scrollWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.colContainer}>Container</th>
                  <th className={styles.colClient}>Client</th>
                  <th className={styles.colDate}>Deployed Date</th>
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
                  // PO has no start date of its own anywhere in this system —
                  // explicit request 2026-10-19 ("po vaild date start dat...
                  // yah bhi all month green hona chahiye", container
                  // KKFU6994964: Agreement Jan->Dec, PO also valid till Dec —
                  // expected Jan-Dec green for PO too, same as Agreement):
                  // reusing the Agreement's own START date, not its END date,
                  // as the PO's implicit start — "PO ends where Agreement
                  // ends" (same date) must mean "PO runs the same full span
                  // as the Agreement", not collapse to a single month. Only
                  // when PO ends AFTER the Agreement (a real continuation,
                  // e.g. CXRU1249797: Agreement Aug->Sep, PO->Oct) does this
                  // naturally extend the ticked range past the Agreement's
                  // own end, which is still correct either way.
                  const agrRange = resolveCoverageRange({ startStr: c.agreementStartDate, endStr: c.agreementDate, band: agrBand, deployedDate: c.deployedDate, year: displayedYear });
                  const poRange = resolveCoverageRange({ startStr: c.agreementStartDate, endStr: c.poDate, band: poBand, deployedDate: c.deployedDate, year: displayedYear });
                  const range = dataView === 'po' ? poRange : agrRange;
                  // Explicit request 2026-10-23: highlight the whole row once
                  // either date is due soon OR already overdue (both grey now,
                  // not red — see bandForDate's own comment) — whichever view
                  // is showing (Agreement-wise/PO-wise), both dates are still
                  // checked so a row doesn't lose its highlight just because
                  // the OTHER date happens to still be safely far out.
                  const rowDueSoon = agrBand === 'dueSoon' || agrBand === 'overdue' || poBand === 'dueSoon' || poBand === 'overdue';
                  return (
                    <tr
                      key={c.container}
                      className={`${styles.clickRow} ${rowDueSoon ? styles.rowDueSoon : ''}`}
                      onClick={() => setSelected(c)}
                    >
                      <td className={styles.colContainer} title={c.container}>{c.container}</td>
                      <td className={styles.colClient} title={c.clientName}>{c.clientName}</td>
                      <td className={styles.colDate}>{formatDisplayDate(c.deployedDate)}</td>
                      <td className={`${styles.colDate} ${agrBand ? styles[BAND_TEXT_TONE[agrBand]] : ''}`}>{formatDisplayDate(c.agreementDate)}</td>
                      <td className={`${styles.colDate} ${poBand ? styles[BAND_TEXT_TONE[poBand]] : ''}`}>{formatDisplayDate(c.poDate)}</td>
                      {monthList.map((m) => {
                        // Explicit, repeated request 2026-10-19 ("red chcek
                        // box nahi chahiye... bas red kuch nahi, jiska nahi
                        // hai woh blank ho jaye"): just two states now, green
                        // (covered) or blank (not) — no more solid-red
                        // "lapsed/overdue" fill. Agreement view: checked for
                        // every month the start-to-valid-till range covers —
                        // but MOST containers have no start date on file, so
                        // agrRange is null for most rows; those tick just
                        // their valid-till month instead. PO view: same
                        // idea, using the Agreement's own start date (see
                        // poRange above).
                        // resolveCoverageRange always returns either a real
                        // {from, to} range or null — a single valid-till
                        // month comes back as {from: m, to: m}, so there's
                        // no separate single-month case to handle here.
                        const inRange = range ? (m >= range.from && m <= range.to) : false;
                        const label = dataView === 'po' ? 'PO' : 'Agreement';
                        const title = inRange
                          ? (range.from !== range.to ? `${label} covers ${c.agreementStartDate} to ${dataView === 'po' ? c.poDate : c.agreementDate}` : `${label} valid upto ${dataView === 'po' ? c.poDate : c.agreementDate}`)
                          : undefined;
                        // Explicit request 2026-10-23 ("oct tak pending dikhe,
                        // nov dec na dikhe, jab woh month aayega tab aaye"): a
                        // "pending" empty box only makes sense for a month
                        // that's already happened — a FUTURE month (later in
                        // the displayed year than today, or any month in a
                        // future year) hasn't arrived yet, so it shows nothing
                        // at all until it actually does.
                        const isFutureMonth = displayedYear > today.getFullYear()
                          || (displayedYear === today.getFullYear() && m > today.getMonth());
                        // Same-day follow-up (SZLU9656796: deployed
                        // 09-09-2026, pending boxes were showing Jan-Aug too
                        // — "deployed date 9 mahine pe hai tho uske phele
                        // chcek box pending nahi aane chahiye"): a month
                        // before the container was even deployed can't be
                        // "pending" either — nothing existed yet to be
                        // pending ON.
                        const isBeforeDeployMonth = (() => {
                          if (!c.deployedDate) return false;
                          const [dy, dm] = c.deployedDate.split('-').map(Number);
                          if (dy > displayedYear) return true;
                          if (dy < displayedYear) return false;
                          return m < dm - 1;
                        })();
                        return (
                          <td
                            key={m}
                            className={`${styles.dayCell} ${displayedYear === today.getFullYear() && m === today.getMonth() ? styles.todayCol : ''}`}
                            title={title}
                          >
                            {/* Covered months always get a filled green
                                checkbox; past/current (not-yet-covered)
                                months get an empty "pending" outline; future
                                months get nothing (see isFutureMonth above).
                                Rows with no date at all for the current view
                                are already excluded from the list entirely —
                                see `filtered`'s own filter above. */}
                            {(inRange || (!isFutureMonth && !isBeforeDeployMonth)) && (
                              <span
                                className={`${styles.checkbox} ${inRange ? styles.checkboxChecked : ''}`}
                                style={{ borderColor: inRange ? BAND_COLOR_VAR.safe : BAND_COLOR_VAR.none, background: inRange ? BAND_COLOR_VAR.safe : 'transparent' }}
                              >
                                {inRange && '✓'}
                              </span>
                            )}
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
          <span className={styles.label}>Deployed Date</span>
          <span>{formatDisplayDate(c.deployedDate)}</span>
        </div>
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
