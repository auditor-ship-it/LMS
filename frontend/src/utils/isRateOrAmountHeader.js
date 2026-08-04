/**
 * System-wide convention: rate/amount/pricing columns are hidden from every
 * data grid and detail view in this app (mirrors the main frontend/'s
 * utils/billingDisplay.js isRateOrAmountHeader — no pricing is shown in any
 * workflow grid: Lease Expiry, Renew & Document, Off-Lease, etc.).
 * Matches any header containing one of these substrings, case-insensitive.
 */
const RATE_KEYWORDS = [
  'rate', 'amount', 'value', 'price', 'cost', 'rent',
  'billed', 'received', 'outstanding', 'charge', 'deposit', 'freight'
];

export function isRateOrAmountHeader(h) {
  const hl = String(h == null ? '' : h).toLowerCase();
  return RATE_KEYWORDS.some((kw) => hl.indexOf(kw) !== -1);
}

/** Indices of headers to actually display (rate/amount columns dropped). */
export function visibleHeaderIndexes(headers = []) {
  return headers.map((_, i) => i).filter((i) => !isRateOrAmountHeader(headers[i]));
}
