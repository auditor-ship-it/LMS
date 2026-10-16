import { useMemo, useState } from 'react';
import { PageHeader, Card, Button, SearchBar, ErrorState, EmptyState } from '../../components/ui/index.js';
import { SkeletonTable } from '../../components/ui/Skeleton.jsx';
import { useAsync } from '../../hooks/useAsync.js';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import { fetchPoAgreementTracker } from '../../services/poAgreementTracker.service.js';
import styles from './PoAgreementTrackerPage.module.css';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* Same day-count bands as Lease Expiry (expiry.service.js) and its Ageing
   filter — a date's color here always means the same thing it means there:
   overdue (past), critical (<=7d), warning (<=30d), else safe. */
function bandForDate(dateStr, today) {
  if (!dateStr) return null;
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  const daysUntil = Math.ceil((d - today) / 86400000);
  if (daysUntil < 0) return 'overdue';
  if (daysUntil <= 7) return 'critical';
  if (daysUntil <= 30) return 'warning';
  return 'safe';
}

// Reuses the app's 4 semantic status tones (StatusBadge.module.css) rather
// than inventing a new color system — overdue=error(red), critical=warn
// (amber, "due soon"), warning=info(blue, "upcoming"), safe=success(green).
const BAND_TONE = { overdue: 'bad', critical: 'warn', warning: 'info', safe: 'ok' };
// Same 4 bands, but as TEXT color for the Agreement/PO Date columns — the
// dot classes above (.bad/.warn/.info/.ok) set background, which would turn
// a whole table cell solid red/green; these set color only.
const BAND_TEXT_TONE = { overdue: 'textBad', critical: 'textWarn', warning: 'textInfo', safe: 'textOk' };
// Same 4 bands again, as a light cell-background tint for the Agreement
// coverage bar (a day cell the bar passes through, not just its end date).
const BAND_RANGE_TONE = { overdue: 'rangeBad', critical: 'rangeWarn', warning: 'rangeInfo', safe: 'rangeOk' };
// Year view's month checkboxes are colored inline (border + fill) rather
// than via CSS class, since a checkbox needs both colors set together —
// same 4 bands, as actual CSS variable values.
const BAND_COLOR_VAR = {
  overdue: 'var(--error)',
  critical: 'var(--warn)',
  warning: 'var(--info)',
  safe: 'var(--success)',
  none: 'var(--text-3)'
};

function daysInMonth(year, month) { return new Date(year, month + 1, 0).getDate(); }

/** Day-of-month if `dateStr` ("YYYY-MM-DD") falls in the given year/month, else null. */
function dayInMonth(dateStr, year, month) {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  if (y !== year || m - 1 !== month) return null;
  return d;
}

/** "YYYY-MM-DD" -> "DD-MM-YYYY", matching this app's own date display convention elsewhere. */
function formatDisplayDate(dateStr) {
  if (!dateStr) return '—';
  const [y, m, d] = dateStr.split('-');
  return `${d}-${m}-${y}`;
}

/**
 * The portion of [startStr, endStr] (inclusive) that falls within the given
 * month, as {from, to} day-of-month numbers — or null if there's no start
 * date, no overlap with this month, or the dates are the wrong way round
 * (seen in real data — a stray reversed Agreement Date entry; treated as
 * untrustworthy rather than drawn as a backwards bar). A span that starts
 * before or ends after the displayed month is clipped to day 1 / the
 * month's last day, so it visually continues off either edge.
 */
function coverageDaysForMonth(startStr, endStr, year, month) {
  if (!startStr || !endStr) return null;
  const start = new Date(`${startStr}T00:00:00`);
  const end = new Date(`${endStr}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return null;
  const monthStart = new Date(year, month, 1);
  const monthEnd = new Date(year, month, daysInMonth(year, month));
  if (end < monthStart || start > monthEnd) return null;
  return {
    from: start < monthStart ? 1 : start.getDate(),
    to: end > monthEnd ? monthEnd.getDate() : end.getDate()
  };
}

/** Year-view equivalents of dayInMonth/coverageDaysForMonth — month-level
    instead of day-level, for the "whole year at a glance" view. */
function monthOfYear(dateStr, year) {
  if (!dateStr) return null;
  const [y, m] = dateStr.split('-').map(Number);
  return y === year ? m - 1 : null;
}
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
 * PO & Agreement Tracker — explicit request 2026-10-16: a day-strip view
 * (styled after a reference CRM follow-up tracker) of every deployed
 * container's Agreement Valid Upto / PO Validity dates, one month at a
 * time, colored by urgency. Backed by GET /dashboard/po-agreement-tracker
 * (dashboard.service.js's getPoAgreementTrackerData, itself reusing
 * getExpiryDataByFilter('pending', null) — the same unscoped "every
 * deployed container" list Lease Expiry's own digest email already uses).
 *
 * Agreement shows a full green-when-safe coverage BAR from its start date
 * (joined from the "New lease reff" sheet's own Agreement Date column —
 * see _agreementStartDateMap, backend/src/services/expiry.service.js) to
 * its valid-upto date. That start date only exists for containers entered
 * through that sheet (~15% of today's deployed fleet) — a container
 * without one falls back to a single end-date dot, same as PO always does:
 * no PO start date is tracked anywhere in this system, so PO is always a
 * single point, never a bar.
 */
export function PoAgreementTrackerPage() {
  const { data, loading, error, reload } = useAsync(fetchPoAgreementTracker, []);
  const [viewMode, setViewMode] = useState('day'); // 'day' (one month, by day) | 'year' (whole year, by month)
  const [monthOffset, setMonthOffset] = useState(0);
  const [yearOffset, setYearOffset] = useState(0);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 200);
  const [onlyThisMonth, setOnlyThisMonth] = useState(false);

  const today = useMemo(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }, []);
  const displayed = useMemo(() => {
    const base = new Date(today.getFullYear(), today.getMonth() + monthOffset, 1);
    return { year: base.getFullYear(), month: base.getMonth() };
  }, [today, monthOffset]);
  const displayedYear = today.getFullYear() + yearOffset;
  const numDays = daysInMonth(displayed.year, displayed.month);
  const dayList = useMemo(() => Array.from({ length: numDays }, (_, i) => i + 1), [numDays]);
  const monthList = useMemo(() => Array.from({ length: 12 }, (_, i) => i), []);
  const isCurrentMonth = displayed.year === today.getFullYear() && displayed.month === today.getMonth();

  const containers = data?.containers || [];
  const filtered = useMemo(() => {
    const term = debouncedSearch.trim().toLowerCase();
    let out = containers;
    if (term) out = out.filter((c) => c.container.toLowerCase().includes(term) || c.clientName.toLowerCase().includes(term));
    if (onlyThisMonth) {
      out = viewMode === 'year'
        ? out.filter((c) => monthOfYear(c.agreementDate, displayedYear) !== null || monthOfYear(c.poDate, displayedYear) !== null)
        : out.filter((c) => dayInMonth(c.agreementDate, displayed.year, displayed.month) || dayInMonth(c.poDate, displayed.year, displayed.month));
    }
    return out;
  }, [containers, debouncedSearch, onlyThisMonth, displayed, viewMode, displayedYear]);

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
            <button type="button" className={viewMode === 'day' ? styles.viewBtnActive : styles.viewBtn} onClick={() => setViewMode('day')}>Day view</button>
            <button type="button" className={viewMode === 'year' ? styles.viewBtnActive : styles.viewBtn} onClick={() => setViewMode('year')}>Year view</button>
          </div>
          <label className={styles.checkboxLabel}>
            <input type="checkbox" checked={onlyThisMonth} onChange={(e) => setOnlyThisMonth(e.target.checked)} />
            Only show containers due {viewMode === 'year' ? 'this year' : 'this month'}
          </label>
          {viewMode === 'day' ? (
            <div className={styles.monthNav}>
              <button type="button" className={styles.navBtn} onClick={() => setMonthOffset((m) => m - 1)} aria-label="Previous month">‹</button>
              <span className={styles.monthLabel}>{MONTH_NAMES[displayed.month]} {displayed.year}</span>
              <button type="button" className={styles.navBtn} onClick={() => setMonthOffset((m) => m + 1)} aria-label="Next month">›</button>
              {monthOffset !== 0 && <button type="button" className={styles.todayBtn} onClick={() => setMonthOffset(0)}>This month</button>}
            </div>
          ) : (
            <div className={styles.monthNav}>
              <button type="button" className={styles.navBtn} onClick={() => setYearOffset((y) => y - 1)} aria-label="Previous year">‹</button>
              <span className={styles.monthLabel}>{displayedYear}</span>
              <button type="button" className={styles.navBtn} onClick={() => setYearOffset((y) => y + 1)} aria-label="Next year">›</button>
              {yearOffset !== 0 && <button type="button" className={styles.todayBtn} onClick={() => setYearOffset(0)}>This year</button>}
            </div>
          )}
        </div>

        {error && <ErrorState message={error} onRetry={reload} />}
        {!error && loading && <SkeletonTable columns={6} rows={10} />}
        {!error && !loading && !filtered.length && <EmptyState message="No containers found" />}
        {!error && !loading && filtered.length > 0 && (
          <div className={styles.scrollWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.colContainer}>Container</th>
                  <th className={styles.colClient}>Client</th>
                  <th className={styles.colDate}>Agreement Date</th>
                  <th className={styles.colDate}>PO Date</th>
                  {viewMode === 'day'
                    ? dayList.map((d) => (
                        <th key={d} className={isCurrentMonth && d === today.getDate() ? styles.todayCol : undefined}>{d}</th>
                      ))
                    : monthList.map((m) => (
                        <th key={m} className={displayedYear === today.getFullYear() && m === today.getMonth() ? styles.todayCol : undefined}>{MONTH_SHORT[m]}</th>
                      ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((c) => {
                  const agrBand = bandForDate(c.agreementDate, today);
                  const poBand = bandForDate(c.poDate, today);
                  return (
                    <tr key={c.container}>
                      <td className={styles.colContainer}>{c.container}</td>
                      <td className={styles.colClient}>{c.clientName}</td>
                      <td className={`${styles.colDate} ${agrBand ? styles[BAND_TEXT_TONE[agrBand]] : ''}`}>{formatDisplayDate(c.agreementDate)}</td>
                      <td className={`${styles.colDate} ${poBand ? styles[BAND_TEXT_TONE[poBand]] : ''}`}>{formatDisplayDate(c.poDate)}</td>
                      {viewMode === 'day' ? (() => {
                        const agrDay = dayInMonth(c.agreementDate, displayed.year, displayed.month);
                        const poDay = dayInMonth(c.poDate, displayed.year, displayed.month);
                        const agrRange = coverageDaysForMonth(c.agreementStartDate, c.agreementDate, displayed.year, displayed.month);
                        return dayList.map((d) => {
                          const inRange = agrRange && d >= agrRange.from && d <= agrRange.to;
                          return (
                            <td
                              key={d}
                              className={`${styles.dayCell} ${isCurrentMonth && d === today.getDate() ? styles.todayCol : ''} ${inRange ? styles[BAND_RANGE_TONE[agrBand]] : ''}`}
                              title={inRange ? `Agreement covers ${c.agreementStartDate} to ${c.agreementDate}` : undefined}
                            >
                              {agrDay === d && (
                                <span className={`${styles.dot} ${styles[BAND_TONE[agrBand]]}`} title={`Agreement valid upto ${c.agreementDate}`} />
                              )}
                              {poDay === d && (
                                <span className={`${styles.dot} ${styles.dotSquare} ${styles[BAND_TONE[poBand]]}`} title={`PO valid upto ${c.poDate}`} />
                              )}
                            </td>
                          );
                        });
                      })() : (() => {
                        const poMonth = monthOfYear(c.poDate, displayedYear);
                        const agrRange = coverageMonthsForYear(c.agreementStartDate, c.agreementDate, displayedYear);
                        const toneVar = BAND_COLOR_VAR[agrBand] || BAND_COLOR_VAR.none;
                        return monthList.map((m) => {
                          const inRange = agrRange && m >= agrRange.from && m <= agrRange.to;
                          return (
                            <td
                              key={m}
                              className={`${styles.dayCell} ${displayedYear === today.getFullYear() && m === today.getMonth() ? styles.todayCol : ''}`}
                              title={inRange ? `Agreement covers ${c.agreementStartDate} to ${c.agreementDate}` : undefined}
                            >
                              <span
                                className={`${styles.checkbox} ${inRange ? styles.checkboxChecked : ''}`}
                                style={{ borderColor: toneVar, background: inRange ? toneVar : 'transparent' }}
                              >
                                {inRange && '✓'}
                              </span>
                              {poMonth === m && (
                                <span className={`${styles.dot} ${styles.dotSquare} ${styles[BAND_TONE[poBand]]}`} title={`PO valid upto ${c.poDate}`} />
                              )}
                            </td>
                          );
                        });
                      })()}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className={styles.legend}>
          <span className={styles.legendItem}><span className={`${styles.dot} ${styles.bad}`} />Overdue</span>
          <span className={styles.legendItem}><span className={`${styles.dot} ${styles.warn}`} />Due soon (≤7d)</span>
          <span className={styles.legendItem}><span className={`${styles.dot} ${styles.info}`} />Upcoming (≤30d)</span>
          <span className={styles.legendItem}><span className={`${styles.dot} ${styles.ok}`} />Safe</span>
          <span className={styles.legendDivider} />
          <span className={styles.legendItem}><span className={styles.dot} />Agreement (end date; shaded bar = covered span, where a start date is on file)</span>
          <span className={styles.legendItem}><span className={`${styles.dot} ${styles.dotSquare}`} />PO (end date only — no start date tracked)</span>
        </div>
      </Card>
    </>
  );
}
