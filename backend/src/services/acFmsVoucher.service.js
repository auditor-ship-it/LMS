/**
 * Accounts' own "A/C FMS" workbook (a SEPARATE external spreadsheet, not
 * mirrored into Mongo like this app's own sheets) — explicit request
 * 2026-11-19 ("vr no bhi hai and utr bhi hai pls chcek yah vr no fetch ho
 * raha hai yah utho and image one se utr samjhe"). Accounts already records,
 * once a voucher is actually raised and paid:
 *   - the voucher number itself, on the "SecurityDeposit" tab, matched by
 *     Container No / Off-Lease ID (same multi-container joined-cell
 *     convention as this app's own refunds.service.js — a bulk-submitted
 *     bill's row carries several containers/lease IDs in one cell).
 *   - a payment reference (that tab's own "UTR" column — an internal
 *     Accounts reference string, e.g. "CMS/.../ZENFOLD_131126_12", not
 *     necessarily a literal bank UTR) on the "NewACCOUNTSFMS" tab, matched
 *     by that same Voucher No.
 * Stage 7 (Payment Status)'s own VR/UTR fields read this instead of asking
 * someone to retype numbers Accounts has already recorded elsewhere.
 *
 * Read-only, same posture as every other external-sheet fetch in this app
 * (Accounts & Collection Outstanding, Sales CRM leads, Stage1 addresses):
 * never written to, and any failure degrades to "not found" rather than
 * breaking the page.
 */
import { getRange } from './googleSheets.service.js';
import { splitContainers } from '../utils/normalize.js';
import { cacheGetOrLoad, cacheRemove } from '../utils/memoryCache.js';

const AC_FMS_SPREADSHEET_ID = '1kUNzd5rNMhpSbUMWDovNi-Ayts_lD5HsKMWp-Mbfqq8';
const SECURITY_DEPOSIT_TAB = 'SecurityDeposit';
const NEW_ACCOUNTS_FMS_TAB = 'NewACCOUNTSFMS';
/** NewACCOUNTSFMS's real header row is row 7 — rows 1-6 hold its own
 *  "Who/How/When" change-log banner, confirmed live via a direct read
 *  (row 1-6 are not column headers at all). SecurityDeposit's header IS row
 *  1, the normal case. */
const NEW_ACCOUNTS_FMS_HEADER_ROW = 7;

const CACHE_KEY = 'ac_fms_voucher_index_v1';
const CACHE_TTL_SECS = 300;

function headerIndex(headers, name) {
  return headers.findIndex((h) => String(h || '').trim().toLowerCase() === name.toLowerCase());
}

async function buildIndex() {
  /* SecurityDeposit: Container No -> { vrNumber, offLeaseId } — every
     container on a row's joined cell maps to the SAME row's one VR No.
     (position doesn't matter here, unlike refunds.service.js's per-
     container Off-Lease ID pairing, since this sheet doesn't split that
     finely — it's one voucher per bill, covering every container on it). */
  const sdRange = await getRange(SECURITY_DEPOSIT_TAB, 'A1:AO5000', AC_FMS_SPREADSHEET_ID);
  const sdHeaders = sdRange[0] || [];
  const containerCol = headerIndex(sdHeaders, 'Container No');
  const vrCol = headerIndex(sdHeaders, 'VR No.');
  const byContainer = new Map();
  if (containerCol >= 0 && vrCol >= 0) {
    for (let i = 1; i < sdRange.length; i++) {
      const row = sdRange[i];
      if (!row) continue;
      const vrNumber = String(row[vrCol] || '').trim();
      if (!vrNumber) continue; // no voucher raised yet for this bill
      for (const c of splitContainers(row[containerCol])) {
        const key = c.trim().toUpperCase();
        if (key) byContainer.set(key, vrNumber);
      }
    }
  }

  /* NewACCOUNTSFMS: Voucher No. -> UTR (its own payment-reference column). */
  const lastRow = NEW_ACCOUNTS_FMS_HEADER_ROW;
  const nfRange = await getRange(NEW_ACCOUNTS_FMS_TAB, `A${lastRow}:S20000`, AC_FMS_SPREADSHEET_ID);
  const nfHeaders = nfRange[0] || [];
  const voucherCol = headerIndex(nfHeaders, 'Voucher No.');
  const utrCol = headerIndex(nfHeaders, 'UTR');
  const byVoucher = new Map();
  if (voucherCol >= 0 && utrCol >= 0) {
    for (let i = 1; i < nfRange.length; i++) {
      const row = nfRange[i];
      if (!row) continue;
      const voucherNo = String(row[voucherCol] || '').trim();
      if (!voucherNo) continue;
      const utr = String(row[utrCol] || '').trim();
      if (utr) byVoucher.set(voucherNo, utr); // last one wins — sheet is append-only, later = more current
    }
  }

  return { byContainer, byVoucher };
}

async function getIndex() {
  return cacheGetOrLoad(CACHE_KEY, CACHE_TTL_SECS, buildIndex);
}

/**
 * `{ vrNumber, utr } | null` for one container — null when Accounts hasn't
 * recorded a voucher for it yet (or the container isn't on file at all),
 * never thrown. `vrNumber` without a matching `utr` (voucher raised but not
 * yet paid) returns `{ vrNumber, utr: '' }`, same "say exactly what's known,
 * no more" posture as refunds.service.js's own 'Unassigned' sentinel.
 */
export async function getAcFmsVoucherForContainer(containerNo) {
  const want = String(containerNo || '').trim().toUpperCase();
  if (!want) return null;
  try {
    const idx = await getIndex();
    const vrNumber = idx.byContainer.get(want);
    if (!vrNumber) return null;
    return { vrNumber, utr: idx.byVoucher.get(vrNumber) || '' };
  } catch (e) {
    console.error('[AC-FMS] voucher lookup failed (best-effort, falling back to manual entry):', e?.message || e);
    return null;
  }
}

/** Drops the cached index so the next read re-fetches both A/C FMS tabs —
 *  the 5-minute TTL handles the normal case on its own; exported for parity
 *  with the other external-sheet caches (salesCrmLeads.service.js's own
 *  invalidate) in case a manual refresh trigger is wired to this later. */
export function invalidateAcFmsVoucherCache() {
  cacheRemove(CACHE_KEY);
}
