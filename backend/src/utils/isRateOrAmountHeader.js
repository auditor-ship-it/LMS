/**
 * System-wide convention: rate/amount/pricing columns are hidden from every
 * data grid and detail view in this app (mirrors the frontend's own
 * utils/isRateOrAmountHeader.js — no pricing is shown in any workflow grid:
 * Lease Expiry, Renew & Document, Off-Lease, etc.). Matches any header
 * containing one of these substrings, case-insensitive.
 */
const RATE_KEYWORDS = [
  'rate', 'amount', 'value', 'price', 'cost', 'rent',
  'billed', 'received', 'outstanding', 'charge', 'deposit', 'freight'
];

export function isRateOrAmountHeader(h) {
  const hl = String(h == null ? '' : h).toLowerCase();
  return RATE_KEYWORDS.some((kw) => hl.indexOf(kw) !== -1);
}
