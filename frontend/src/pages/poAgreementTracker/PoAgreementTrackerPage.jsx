import { useMemo, useState } from 'react';
import { PageHeader, Card, Button, SearchBar, ErrorState, EmptyState } from '../../components/ui/index.js';
import { SkeletonTable } from '../../components/ui/Skeleton.jsx';
import { useAsync } from '../../hooks/useAsync.js';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import { fetchPoAgreementTracker } from '../../services/poAgreementTracker.service.js';
import styles from './PoAgreementTrackerPage.module.css';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

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
 * PO & Agreement Tracker — explicit request 2026-10-16: a day-strip view
 * (styled after a reference CRM follow-up tracker) of every deployed
 * container's Agreement Valid Upto / PO Validity dates, one month at a
 * time, colored by urgency. Backed by GET /dashboard/po-agreement-tracker
 * (dashboard.service.js's getPoAgreementTrackerData, itself reusing
 * getExpiryDataByFilter('pending', null) — the same unscoped "every
 * deployed container" list Lease Expiry's own digest email already uses).
 *
 * No Agreement-start/PO-start date exists anywhere in this system (checked
 * before building this) — so this plots the expiry/validity date itself as
 * a single point on the day strip, not a start->end coverage bar.
 */
export function PoAgreementTrackerPage() {
  const { data, loading, error, reload } = useAsync(fetchPoAgreementTracker, []);
  const [monthOffset, setMonthOffset] = useState(0);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 200);
  const [onlyThisMonth, setOnlyThisMonth] = useState(false);

  const today = useMemo(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }, []);
  const displayed = useMemo(() => {
    const base = new Date(today.getFullYear(), today.getMonth() + monthOffset, 1);
    return { year: base.getFullYear(), month: base.getMonth() };
  }, [today, monthOffset]);
  const numDays = daysInMonth(displayed.year, displayed.month);
  const dayList = useMemo(() => Array.from({ length: numDays }, (_, i) => i + 1), [numDays]);
  const isCurrentMonth = displayed.year === today.getFullYear() && displayed.month === today.getMonth();

  const containers = data?.containers || [];
  const filtered = useMemo(() => {
    const term = debouncedSearch.trim().toLowerCase();
    let out = containers;
    if (term) out = out.filter((c) => c.container.toLowerCase().includes(term) || c.clientName.toLowerCase().includes(term));
    if (onlyThisMonth) {
      out = out.filter((c) => dayInMonth(c.agreementDate, displayed.year, displayed.month) || dayInMonth(c.poDate, displayed.year, displayed.month));
    }
    return out;
  }, [containers, debouncedSearch, onlyThisMonth, displayed]);

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
          <label className={styles.checkboxLabel}>
            <input type="checkbox" checked={onlyThisMonth} onChange={(e) => setOnlyThisMonth(e.target.checked)} />
            Only show containers due this month
          </label>
          <div className={styles.monthNav}>
            <button type="button" className={styles.navBtn} onClick={() => setMonthOffset((m) => m - 1)} aria-label="Previous month">‹</button>
            <span className={styles.monthLabel}>{MONTH_NAMES[displayed.month]} {displayed.year}</span>
            <button type="button" className={styles.navBtn} onClick={() => setMonthOffset((m) => m + 1)} aria-label="Next month">›</button>
            {monthOffset !== 0 && <button type="button" className={styles.todayBtn} onClick={() => setMonthOffset(0)}>This month</button>}
          </div>
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
                  {dayList.map((d) => (
                    <th key={d} className={isCurrentMonth && d === today.getDate() ? styles.todayCol : undefined}>{d}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((c) => {
                  const agrDay = dayInMonth(c.agreementDate, displayed.year, displayed.month);
                  const poDay = dayInMonth(c.poDate, displayed.year, displayed.month);
                  const agrBand = bandForDate(c.agreementDate, today);
                  const poBand = bandForDate(c.poDate, today);
                  return (
                    <tr key={c.container}>
                      <td className={styles.colContainer}>{c.container}</td>
                      <td className={styles.colClient}>{c.clientName}</td>
                      <td className={`${styles.colDate} ${agrBand ? styles[BAND_TEXT_TONE[agrBand]] : ''}`}>{formatDisplayDate(c.agreementDate)}</td>
                      <td className={`${styles.colDate} ${poBand ? styles[BAND_TEXT_TONE[poBand]] : ''}`}>{formatDisplayDate(c.poDate)}</td>
                      {dayList.map((d) => (
                        <td key={d} className={`${styles.dayCell} ${isCurrentMonth && d === today.getDate() ? styles.todayCol : ''}`}>
                          {agrDay === d && (
                            <span className={`${styles.dot} ${styles[BAND_TONE[agrBand]]}`} title={`Agreement valid upto ${c.agreementDate}`} />
                          )}
                          {poDay === d && (
                            <span className={`${styles.dot} ${styles.dotSquare} ${styles[BAND_TONE[poBand]]}`} title={`PO valid upto ${c.poDate}`} />
                          )}
                        </td>
                      ))}
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
          <span className={styles.legendItem}><span className={styles.dot} />Agreement</span>
          <span className={styles.legendItem}><span className={`${styles.dot} ${styles.dotSquare}`} />PO</span>
        </div>
      </Card>
    </>
  );
}
