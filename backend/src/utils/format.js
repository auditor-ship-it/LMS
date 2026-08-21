/**
 * Ported verbatim (logic preserved exactly) from LMS.js: parseDate, safeStr,
 * formatDateVal, safeAmt, _toNum, buildDisplayRow, _usefulCols.
 * These run against values already read out of the Sheets API (strings/numbers),
 * so the `val instanceof Date` branches only fire for values we construct
 * ourselves (e.g. `new Date()` timestamps built server-side before writing).
 */

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatDMY(d, sep) {
  return `${pad2(d.getDate())}${sep}${pad2(d.getMonth() + 1)}${sep}${d.getFullYear()}`;
}

export function parseDate(val) {
  if (val instanceof Date) { if (!isNaN(val.getTime())) return val; }
  if (!val) return null;
  const s = String(val).trim();
  if (s === '') return null;

  let m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) {
    const dd = parseInt(m[1], 10), mm = parseInt(m[2], 10) - 1;
    let yy = parseInt(m[3], 10); if (yy < 100) yy += 2000;
    const d = new Date(yy, mm, dd);
    if (!isNaN(d.getTime())) return d;
  }

  m = s.match(/^(\d{1,2})\s*(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+(\d{2,4})$/i);
  if (m) {
    const dd = parseInt(m[1], 10), mm = MONTHS[m[2].toLowerCase().substring(0, 3)];
    let yy = parseInt(m[3], 10); if (yy < 100) yy += 2000;
    const d = new Date(yy, mm, dd);
    if (!isNaN(d.getTime())) return d;
  }

  m = s.match(/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+(\d{2,4})$/i);
  if (m) {
    const mm = MONTHS[m[1].toLowerCase().substring(0, 3)];
    let yy = parseInt(m[2], 10); if (yy < 100) yy += 2000;
    const d = new Date(yy, mm, 1);
    if (!isNaN(d.getTime())) return d;
  }

  const d = new Date(s);
  if (!isNaN(d.getTime())) return d;
  return null;
}

export function safeStr(val) {
  if (val == null) return '';
  if (val instanceof Date) return formatDMY(val, '/');
  return String(val);
}

/** dd/MM/yyyy HH:mm:ss (24h, local time) — the "system update/submission"
 *  timestamp shape used when a write needs to record exactly when it
 *  happened, e.g. into a Sheet cell as literal text. Several services
 *  (approve/verify/offlease/stage9) already define this exact function
 *  locally, independently, from their own original ports — left as-is there
 *  rather than risk touching working code. This copy exists so a NEW call
 *  site (e.g. auth.service.js's login-activity log) has one to import
 *  instead of adding a seventh private copy, or worse, reaching for
 *  `new Date().toISOString()` — which is exactly the raw-ISO-in-the-UI bug
 *  this function exists to prevent (see the 2026-08-20 timestamp-formatting
 *  request). */
export function dmyTime(d) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return '';
  return `${formatDMY(d, '/')} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** Inverse of dmyTime() — parses "dd/MM/yyyy HH:mm:ss" (or date-only
 *  "dd/MM/yyyy") back into a Date. Returns null if it doesn't match that
 *  shape, so a caller reading a column that might still hold an older raw
 *  ISO value (written before a call site switched to dmyTime) can fall back
 *  to `new Date(s)` for those — see auth.service.js's empHeartbeat. */
export function parseDmyTime(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return null;
  const [, dd, mo, yy, hh, mi, ss] = m;
  let year = parseInt(yy, 10);
  if (year < 100) year += 2000;
  const d = new Date(year, parseInt(mo, 10) - 1, parseInt(dd, 10), hh ? parseInt(hh, 10) : 0, mi ? parseInt(mi, 10) : 0, ss ? parseInt(ss, 10) : 0);
  return isNaN(d.getTime()) ? null : d;
}

export function formatDateVal(val) {
  if (!val) return '';
  if (val instanceof Date && !isNaN(val.getTime())) {
    return formatDMY(val, '-');
  }
  if (typeof val === 'number' && val > 25000 && val < 60000) {
    // Sheets serial date -> JS date (Sheets epoch 1899-12-30)
    const d = new Date(Math.round((val - 25569) * 86400000));
    if (!isNaN(d.getTime())) return formatDMY(d, '-');
  }
  return String(val).trim();
}

// Amount round-up helpers
const AMT_KW = ['amount', 'total', 'rate', 'price', 'value', 'bill', 'rent', 'charges', 'cost', 'received', 'outstanding', 'billed'];

export function safeAmt(val) {
  if (typeof val === 'number') return String(Math.ceil(val));
  return safeStr(val);
}

// Extract a number — whether it's a number or text ("27000", "₹27,000"). Blank/invalid -> 0
export function toNum(v) {
  if (typeof v === 'number') return isNaN(v) ? 0 : v;
  if (v == null) return 0;
  const n = parseFloat(String(v).replace(/[^0-9.-]/g, ''));
  return isNaN(n) ? 0 : n;
}

export function buildDisplayRow(srcRow, indices, headers) {
  let idx = indices;
  if (typeof idx === 'number') {
    idx = Array.from({ length: idx }, (_, x) => x);
  }
  return idx.map((ci) => {
    const val = srcRow[ci];
    if (typeof val === 'number' && ci < headers.length) {
      const h = String(headers[ci] || '').toLowerCase();
      for (const kw of AMT_KW) {
        if (h.indexOf(kw) !== -1) return String(Math.ceil(val));
      }
    }
    return safeStr(val);
  });
}

// Which columns are worth rendering: those with a header, or with data in at
// least one row. Returns an array of 0-based column indices.
export function usefulCols(headers, rows, count) {
  const keep = [];
  for (let c = 0; c < count; c++) {
    const h = (headers[c] == null ? '' : headers[c]).toString().trim();
    if (h !== '') { keep.push(c); continue; }
    for (const row of rows) {
      const v = row[c];
      if (v != null && String(v).trim() !== '') { keep.push(c); break; }
    }
  }
  return keep.length ? keep : [0];
}
