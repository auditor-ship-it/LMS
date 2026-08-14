/**
 * Client for the Accounts & Collection app (accounts-collection.vercel.app),
 * used to show Tally outstanding on Off-Lease Stage 1.
 *
 * AUTH: that service authenticates by Employee ID + password and returns a
 * bearer token; the `cak_` API key it also issues is not accepted on data
 * routes (verified — a deliberately bogus key gets the identical 401). So we
 * log in once with a service account and cache the token.
 *
 * Credentials live in backend/.env and never reach the browser — the frontend
 * calls our own /api/offlease/:containerNo/outstanding, which proxies here.
 */
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const BASE = (env.accountsApiUrl || 'https://accounts-collection.vercel.app').replace(/\/+$/, '');
const TOKEN_TTL_MS = 20 * 60 * 1000; // re-login well inside any server-side expiry
/** /api/search returns only 6 rows unless `limit` is passed — high enough that
 *  no invoice's container list is ever cut short. */
const SEARCH_LIMIT = 500;

let cached = { token: '', at: 0 };

async function getToken(force = false) {
  if (!force && cached.token && Date.now() - cached.at < TOKEN_TTL_MS) return cached.token;
  if (!env.accountsApiEmpId || !env.accountsApiPassword) {
    throw new Error('ACCOUNTS_API_EMP_ID / ACCOUNTS_API_PASSWORD are not set in backend/.env');
  }
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ empId: env.accountsApiEmpId, password: env.accountsApiPassword })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body?.token) throw new Error(`Accounts API login failed (${res.status}): ${body?.error || 'no token'}`);
  cached = { token: body.token, at: Date.now() };
  logger.info(`[ACCOUNTS-API] logged in as ${body.name || env.accountsApiEmpId}`);
  return cached.token;
}

/** GET with the cached token; one silent retry after a fresh login on 401. */
async function apiGet(path, retry = true) {
  const token = await getToken();
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
  });
  if (res.status === 401 && retry) { cached = { token: '', at: 0 }; return apiGet(path, false); }
  if (!res.ok) throw new Error(`Accounts API ${path} -> ${res.status}`);
  return res.json();
}

/** Party names differ in punctuation/suffix between systems, e.g.
 *  "63Ideas Infolabs Pvt Ltd" vs "63Ideas Infolabs Private Limited". */
function normName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\b(private|pvt|limited|ltd|llp|inc|co|company)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

const num = (v) => { const n = Number(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** The API returns period as either "Apr 2026" or "4 2026" — normalise the
 *  numeric form so the column reads consistently. */
function fmtPeriod(v) {
  const s = String(v ?? '').trim();
  const m = s.match(/^(\d{1,2})\s+(\d{4})$/);
  return m && MONTHS[Number(m[1]) - 1] ? `${MONTHS[Number(m[1]) - 1]} ${m[2]}` : s;
}

/**
 * Outstanding for one container, keyed on container number AND client name.
 *
 *  - /api/search?q=<container> gives the container's own invoices
 *  - /api/tally/outstanding gives party-level Tally outstanding and bills
 *
 * Both are used: the container view is precise, the party view carries the
 * Tally figure the user wants shown.
 */
export async function getOutstandingForContainer(containerNo, clientName) {
  const out = {
    container: containerNo,
    clientName: clientName || '',
    matchedParty: '',
    tallyOutstanding: null,
    invoices: [],
    bills: [],
    error: ''
  };

  try {
    /* &limit is REQUIRED: /api/search caps at 6 rows by default, which silently
       dropped containers from multi-container invoices — QUA/APR137/26-27 has 7
       but returned 5, omitting TRLU8190780 itself. Only `limit` works;
       pageSize/size/max/all are ignored. */
    const search = await apiGet(`/api/search?q=${encodeURIComponent(containerNo)}&limit=${SEARCH_LIMIT}`);
    out.invoices = (search?.invoices || []).map((i) => ({
      invoiceNo: i.invoiceNo || '',
      containerNo: i.containerNo || '',
      clientName: i.clientName || '',
      amount: num(i.amount),
      outstanding: num(i.outstanding),
      overdueDays: num(i.overdueDays),
      band: i.band || '',
      period: i.period || ''
    }));
  } catch (e) {
    out.error = e.message;
    logger.error('[ACCOUNTS-API] search failed:', e.message);
  }

  try {
    const tally = await apiGet('/api/tally/outstanding');
    const parties = tally?.parties || [];

    /* Party selection, most reliable signal first.
     *
     * The container's OWN invoices name their client, so that beats the
     * Off-Lease client field: one legal entity can appear as several Tally
     * parties ("Hatsun Agro Product Limited" and "... - Odisha"), and a loose
     * name match picked whichever came first — which was the wrong one, with
     * the wrong invoices and total.
     *
     * Falling back to the record's client only when the container's invoices
     * name nobody. Exact match is tried before any fuzzy containment so a
     * suffixed party can never shadow the exact one. */
    const fromInvoices = normName(out.invoices.find((i) => i.clientName)?.clientName);
    const fromRecord = normName(clientName);

    const exact = (want) => want && parties.find((p) => normName(p.name) === want);
    const fuzzy = (want) => want && parties.find((p) => {
      const n = normName(p.name);
      return n.includes(want) || want.includes(n);
    });

    /* The container's invoice refs are the decisive tiebreak: the right party
     * is the one whose bills actually contain them. */
    const refs = new Set(out.invoices.map((i) => String(i.invoiceNo).trim()).filter(Boolean));
    const byRefs = refs.size
      ? parties.find((p) => (p.bills || []).some((b) => refs.has(String(b.ref).trim())))
      : null;

    const party = byRefs
      || exact(fromInvoices) || exact(fromRecord)
      || fuzzy(fromInvoices) || fuzzy(fromRecord);
    if (party) {
      out.matchedParty = party.name;
      out.tallyOutstanding = num(party.outstanding);
      out.bills = (party.bills || []).map((b) => ({
        ref: b.ref || '',
        pending: num(b.pending),
        overdueDays: num(b.overdueDays),
        isReceipt: !!b.isReceipt
      }));
    }
  } catch (e) {
    if (!out.error) out.error = e.message;
    logger.error('[ACCOUNTS-API] tally failed:', e.message);
  }

  out.containerShare = out.invoices.reduce((s, i) => s + i.amount, 0);
  out.containerOutstanding = out.invoices.reduce((s, i) => s + i.outstanding, 0);

  /* INVOICE-WISE totals.
   *
   * One invoice covers several containers, and /api/search returns BOTH a
   * consolidated header row (containerNo empty, the full invoice value) and a
   * per-container split row. Summing everything would double-count, so the
   * header row is the invoice total and the splits are ignored.
   *
   * Searching by container only ever returns that container's split, so each
   * invoice is re-fetched by its own number to get the consolidated figure. */
  /* The invoice SET comes from the matched Tally party's own bills — the same
     source the /tally-outstanding modal renders — so this table shows every
     invoice that modal does, not just the ones naming this container.
     Receipts (isReceipt, negative) are payments, not invoices, so excluded.
     Falls back to the container's invoices only when no party matched. */
  /* Receipts are excluded two ways: the isReceipt flag, and a non-positive
     pending. A journal voucher like JV/1171/25-26 is a credit that carries no
     flag but a negative pending — it belongs under RECEIPTS (CR), not in the
     invoice list, and including it inflated the grand total. */
  const partyRefs = out.bills
    .filter((b) => !b.isReceipt && b.pending > 0)
    .map((b) => b.ref)
    .filter(Boolean);
  const invoiceNos = partyRefs.length
    ? [...new Set(partyRefs)]
    : [...new Set(out.invoices.map((i) => i.invoiceNo).filter(Boolean))];
  out.invoiceTotals = [];
  const billByRef = new Map(out.bills.map((b) => [String(b.ref).trim(), b]));
  try {
    const fetched = await Promise.all(invoiceNos.map(async (no) => {
      const j = await apiGet(`/api/search?q=${encodeURIComponent(no)}&limit=${SEARCH_LIMIT}`);
      const rows = (j?.invoices || []).filter((i) => String(i.invoiceNo).trim() === no);
      // The consolidated row is the one with no container against it.
      const header = rows.find((i) => !String(i.containerNo || '').trim());
      if (!rows.length && !billByRef.get(no)) return null;
      /* Invoice total: the consolidated header row when the API supplies one,
         otherwise the SUM of the container splits — an invoice covering two
         containers at 69,502 each is 139,004, not 69,502. Taking rows[0] here
         reported one container's share as the whole invoice. */
      const splits = rows.filter((i) => String(i.containerNo || '').trim());
      const src = header || {
        amount: splits.reduce((s, i) => s + num(i.amount), 0),
        outstanding: splits.reduce((s, i) => s + num(i.outstanding), 0),
        overdueDays: splits[0]?.overdueDays,
        period: splits[0]?.period
      };
      /* Containers billed on this invoice. Searching by invoice number does
         not always return the split rows — when it doesn't, this container is
         still on the invoice (the party matched it), so it is used rather than
         leaving the cell blank. That mirrors the modal's own
         "Container no. matched on N of N invoice(s)". */
      const containers = [...new Set(
        rows.map((i) => String(i.containerNo || '').trim()).filter(Boolean)
      )].sort();
      if (!containers.length && containerNo) containers.push(String(containerNo).trim());
      /* Amount and age come from the PARTY BILL, which is what the
         /tally-outstanding modal renders — /api/search reports a per-container
         slice for some invoices (AUG31 showed 69,384 against the modal's
         76,818, and -19d against 0d). Search is used only to enrich the
         container list and period, which bills do not carry. */
      const bill = billByRef.get(no);
      return {
        invoiceNo: no,
        amount: bill ? num(bill.pending) : num(src.amount),
        outstanding: bill ? num(bill.pending) : num(src.outstanding),
        overdueDays: bill ? num(bill.overdueDays) : num(src.overdueDays),
        period: fmtPeriod(src.period),
        containers,
        containerCount: containers.length,
        consolidated: !!header
      };
    }));
    out.invoiceTotals = fetched.filter(Boolean);
  } catch (e) {
    if (!out.error) out.error = e.message;
    logger.error('[ACCOUNTS-API] invoice totals failed:', e.message);
  }

  out.invoiceCount = out.invoiceTotals.length;
  out.grandTotal = out.invoiceTotals.reduce((s, i) => s + i.amount, 0);
  out.grandOutstanding = out.invoiceTotals.reduce((s, i) => s + i.outstanding, 0);
  return out;
}
