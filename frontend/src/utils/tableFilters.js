/**
 * Small client-side helpers shared by every DataGrid-backed page (Verify /
 * Approve / Lease). These operate on the `{headers, data: [{row, ...}]}`
 * shape returned by the real backend for sheet-style endpoints.
 */
import { visibleHeaderIndexes } from './isRateOrAmountHeader.js';

/** Indices of headers that should stay visible (i.e. not rate/amount columns). */
export function visibleColumnIndices(headers = []) {
  return visibleHeaderIndexes(headers);
}

/** Case-insensitive substring match across every cell of a row. */
export function rowMatchesSearch(row, search) {
  const t = String(search || '').trim().toLowerCase();
  if (!t) return true;
  return (row || []).some((cell) => String(cell ?? '').toLowerCase().includes(t));
}

/**
 * Pick one column to expose as a FilterBar dropdown, without assuming any
 * specific header names (the underlying sheet columns vary and are only
 * known at runtime):
 *  - prefer a header that literally contains "status"
 *  - otherwise fall back to the first visible, non-first column whose
 *    distinct-value count looks categorical (2..8 distinct values) —
 *    e.g. a Yard / Type / Category column — skipping columns that are
 *    effectively unique per row (ids, container numbers, dates, etc).
 * Returns -1 if nothing suitable is found.
 */
export function pickCategoricalFilterColumn(headers = [], items = [], visibleColIdx = []) {
  const statusIdx = visibleColIdx.find((i) => /status/i.test(String(headers[i] || '')));
  if (statusIdx !== undefined) return statusIdx;

  for (const i of visibleColIdx) {
    if (i === 0) continue; // usually the container/id column
    const set = new Set();
    for (const it of items) {
      const v = String((it.row || it || [])[i] ?? '').trim();
      if (v) set.add(v);
      if (set.size > 8) break;
    }
    if (set.size >= 2 && set.size <= 8) return i;
  }
  return -1;
}

/** Distinct, sorted {value,label} option list for a given column index. */
export function distinctOptionsForColumn(items = [], colIdx) {
  if (colIdx == null || colIdx < 0) return [];
  const set = new Set();
  for (const it of items) {
    const v = String((it.row || it || [])[colIdx] ?? '').trim();
    if (v) set.add(v);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b)).map((v) => ({ value: v, label: v }));
}
