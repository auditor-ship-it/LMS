/**
 * The one place the app converts an action's timestamp into what a user
 * reads — "20-Aug-2026 05:34 PM", never a raw ISO string like
 * "2026-08-20T12:04:31.145Z". Use this ONLY for timestamps of an actual
 * tracked action (submitted, approved, verified, modified, created, last
 * used, revoked, logged in, ...) — not for plain business dates (Deployed
 * Date, Valid Upto, ...), which already arrive from the backend pre-formatted
 * as a date with no time component and should keep displaying as-is.
 *
 * Backend timestamps reach the frontend in two shapes today, both handled
 * here:
 *   - A raw ISO string, from a Mongo-native `Date` field JSON-serializes to
 *     (e.g. API key createdAt/lastUsedAt) — `new Date(iso)` already carries
 *     the right instant; every getter below then reads it back in the
 *     browser's LOCAL timezone, so UTC-to-local happens for free.
 *   - "dd/MM/yyyy[ HH:mm[:ss]]", the backend's own dmyTime()/formatDateVal()
 *     convention for values written into a Sheet cell (already local time
 *     when written, since dmyTime reads a Date's local getHours()/etc.).
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad2(n) {
  return String(n).padStart(2, '0');
}

function toDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }

  const s = String(value).trim();
  if (!s) return null;

  // The backend's own "dd/MM/yyyy[ HH:mm[:ss]]" convention (dmyTime/
  // formatDateVal) — checked before falling through to native Date parsing,
  // which would otherwise read an ambiguous d/M/yyyy string as M/d/yyyy.
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const [, dd, mo, yy, hh, mi, ss] = m;
    let year = parseInt(yy, 10);
    if (year < 100) year += 2000;
    const d = new Date(year, parseInt(mo, 10) - 1, parseInt(dd, 10), hh ? parseInt(hh, 10) : 0, mi ? parseInt(mi, 10) : 0, ss ? parseInt(ss, 10) : 0);
    return isNaN(d.getTime()) ? null : d;
  }

  // ISO 8601 and anything else the platform's Date parser accepts.
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * "20-Aug-2026 05:34 PM" — the single format every action timestamp in the
 * app should render as. Returns '' for anything empty/unparseable so a
 * blank field stays blank (or whatever placeholder — e.g. "—" — the caller
 * itself already renders for an empty string) instead of showing "Invalid Date".
 */
export function formatActionTimestamp(value) {
  const d = toDate(value);
  if (!d) return '';
  let hours = d.getHours();
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  return `${pad2(d.getDate())}-${MONTHS[d.getMonth()]}-${d.getFullYear()} ${pad2(hours)}:${pad2(d.getMinutes())} ${ampm}`;
}
