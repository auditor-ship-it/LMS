/**
 * Ported verbatim (logic preserved exactly) from LMS.js: _normKey, _splitContainers,
 * _normClientName (helper functions, not tied to any one screen). Kept as a shared
 * util rather than duplicated per-service because many LMS.js modules beyond this
 * migration slice reuse the exact same normalization (Lease Expiry, Billing,
 * Receivables, Off-Lease, Sale-Exec/Client-Code autofill, ...) — a later
 * integration pass porting those should import from here rather than re-deriving.
 */

/** Case/space-insensitive key for matching container numbers, client names, etc. */
export function normKey(s) {
  return (s == null ? '' : s).toString().trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Split a multi-container cell — only on comma/semicolon/newline (NOT space,
 *  otherwise "Site Cabin 73" would break). */
export function splitContainers(raw) {
  return (raw == null ? '' : raw).toString().split(/[,;\n]+/);
}

/** Normalizes a client/company name for fuzzy matching: drops "c/o ..." tails,
 *  trailing "unit N", punctuation, and common corporate-suffix stopwords, so
 *  e.g. "ITC Ltd C/o KGVK Agro Limited" still matches "ITC". */
export function normClientName(name) {
  let s = (name == null ? '' : name).toString().toLowerCase();
  s = s.replace(/\bc\s*\/\s*o\b.*$/, ' ');
  s = s.replace(/\bunit\b[\s-]*[a-z0-9]*\s*$/, ' ');
  s = s.replace(/[.,\-/()&'"]/g, ' ');
  const stop = new Set([
    'pvt', 'private', 'ltd', 'limited', 'llp', 'company', 'co',
    'corporation', 'corp', 'inc', 'and', 'the'
  ]);
  const toks = s.split(/\s+/).filter((t) => t && !stop.has(t));
  return toks.join(' ').trim();
}
