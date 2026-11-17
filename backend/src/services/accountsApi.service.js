/**
 * Client for the Accounts & Collection app (collections.crystalgrp.xyz),
 * used to show Tally outstanding on Off-Lease Stage 1.
 *
 * REWRITTEN 2026-11-17. Two things changed at once:
 *
 *  1. The old host, accounts-collection.vercel.app, is a DISABLED Vercel
 *     deployment — every route, /api/auth/login included, answers 402
 *     DEPLOYMENT_DISABLED. That was the user-visible "Accounts API login
 *     failed (402): no token" on Off-Lease Stage 1.
 *  2. On the new host the Employee-ID + password service account this file
 *     used to log in with is rejected ("Invalid Employee ID or password"),
 *     and no valid one exists for us. But that app now publishes a proper
 *     read API at /api/v1 authenticated by the `cak_` API key — the same
 *     key family the old header comment dismissed as "not accepted on data
 *     routes". That WAS true of the old session-only routes (/api/search,
 *     /api/tally/outstanding, /api/payment-advice/*, all still 401 to a
 *     key); it is not true of /api/v1/*, which is key-only and is the
 *     supported integration surface. Our key is named "lms", scopes ["*"],
 *     clientAccess "all", 120 req/min.
 *
 * So: no login, no token cache, no credentials — one header, X-API-Key.
 * The key lives in backend/.env and never reaches the browser; the frontend
 * calls our own /api/offlease/:containerNo/outstanding, which proxies here.
 *
 * getOutstandingForContainer's RETURN SHAPE IS UNCHANGED, deliberately —
 * StageDetailModal.jsx and lookupModel.js read these exact fields and were
 * not touched.
 *
 * ONE CAPABILITY IS GONE: per-invoice document links. The old
 * /api/payment-advice/party-ledger carried `invoiceCopyUrl` per bill; /api/v1
 * exposes only a `hasInvoiceCopy` boolean and no URL (and it is false on
 * every invoice sampled). `invoiceUrl` is therefore always '' now. That
 * degrades rather than breaks: both consumers already fall back to the LMS's
 * own Billing Sales file map — see StageDetailModal's `fileFor`.
 */
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const BASE = (env.accountsApiUrl || 'https://collections.crystalgrp.xyz').replace(/\/+$/, '');
const V1 = `${BASE}/api/v1`;
/** The API caps `limit` at 1000 per page; nothing we query here (one
 *  container's months, or one client's) comes anywhere near that. */
const PAGE_LIMIT = 1000;

/* Unchanged from the previous implementation, and for the same reason
   (Off-Lease Record page once hung on "Loading stage data..." because a slow
   Accounts API had nothing to time it out): this is nice-to-have enrichment,
   never core data, and every call site treats failure as out.error. */
const FETCH_TIMEOUT_MS = 8000;
async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Accounts API timed out after ${FETCH_TIMEOUT_MS / 1000}s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** GET a /api/v1 path and return its `data` payload (the envelope is
 *  always { data, pagination?, meta }). */
async function apiGet(path) {
  if (!env.accountsApiKey) {
    throw new Error('ACCOUNTS_API_KEY is not set in backend/.env');
  }
  const res = await fetchWithTimeout(`${V1}${path}`, {
    headers: { 'X-API-Key': env.accountsApiKey, Accept: 'application/json' }
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Accounts API ${path} -> ${res.status}${body?.error ? `: ${body.error}` : ''}`);
  }
  return body?.data;
}

/** Party names differ in punctuation/suffix between systems, e.g.
 *  "63Ideas Infolabs Pvt Ltd" vs "63Ideas Infolabs Private Limited".
 *  /api/v1/clients/:client resolves known aliases on its own, so this is
 *  only needed to pick between candidates from a ?q= search. */
function normName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\b(private|pvt|limited|ltd|llp|inc|co|company)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

const num = (v) => { const n = Number(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };

/** "Dec" + "2025" -> "Dec 2025"; either half may be missing. */
function fmtPeriod(month, year) {
  return [String(month ?? '').trim(), String(year ?? '').trim()].filter(Boolean).join(' ');
}

/**
 * Resolve the Accounts-side client for a container.
 *
 * The lease schedule is the precise signal — it is per container, and names
 * the client that container is actually billed to. The Off-Lease record's own
 * client field is only the fallback, for a container the schedule does not
 * carry (it covers the receivables sheet, ~350 containers, not every one).
 * Same precedence the previous implementation used, for the same reason: one
 * legal entity can appear as several Tally parties, and the container's own
 * billing says which.
 */
async function resolveClientKey(schedRows, clientName) {
  const fromSchedule = schedRows.find((r) => r.clientKey || r.clientName);
  if (fromSchedule) return fromSchedule.clientKey || fromSchedule.clientName;
  if (!clientName) return '';

  /* Try the record's name directly first: /clients/:client matches on the
     client's `aliases` too, so "Takshavi Private Limited" finds "Takshavi"
     without any fuzzy matching on our side. */
  try {
    const direct = await apiGet(`/clients/${encodeURIComponent(clientName)}`);
    if (direct?.clientKey) return direct.clientKey;
  } catch (e) {
    // 404 for an unknown name is expected — fall through to the search.
  }

  const want = normName(clientName);
  const list = await apiGet(`/clients?q=${encodeURIComponent(clientName)}&limit=50`).catch(() => []);
  const candidates = Array.isArray(list) ? list : [];
  /* Exact before fuzzy, so a suffixed party ("... - Odisha") can never
     shadow the exact one. */
  const exact = candidates.find((c) => normName(c.client) === want
    || (c.aliases || []).some((a) => normName(a) === want));
  const fuzzy = candidates.find((c) => {
    const n = normName(c.client);
    return n && (n.includes(want) || want.includes(n));
  });
  return (exact || fuzzy)?.clientKey || '';
}

/**
 * Outstanding for one container, keyed on container number AND client name.
 *
 *  - /api/v1/lease-schedule?container=  the container's own billed months
 *  - /api/v1/clients/:client            party-level Tally outstanding + every invoice
 *  - /api/v1/lease-schedule?client=     which containers each invoice covers
 *
 * All three are used: the schedule is precise per container, the client
 * record carries the Tally figure the user wants shown, and the client-wide
 * schedule is what lets an invoice list the containers it bills for (153 of
 * them cover more than one).
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

  /* This container's own billed months. */
  let schedRows = [];
  try {
    const rows = await apiGet(`/lease-schedule?container=${encodeURIComponent(containerNo)}&limit=${PAGE_LIMIT}`);
    schedRows = Array.isArray(rows) ? rows : [];
  } catch (e) {
    out.error = e.message;
    logger.error('[ACCOUNTS-API] lease-schedule (container) failed:', e.message);
  }

  let client = null;
  try {
    const clientKey = await resolveClientKey(schedRows, clientName);
    if (clientKey) client = await apiGet(`/clients/${encodeURIComponent(clientKey)}`);
  } catch (e) {
    if (!out.error) out.error = e.message;
    logger.error('[ACCOUNTS-API] client lookup failed:', e.message);
  }

  const clientInvoices = Array.isArray(client?.invoices) ? client.invoices : [];
  /* Invoice -> its ageing/overdue, so the container's own rows below can show
     the same age the invoice table does rather than nothing. */
  const invByNo = new Map(clientInvoices.map((i) => [String(i.invoiceNo).trim(), i]));

  out.invoices = schedRows.map((r) => {
    const inv = invByNo.get(String(r.invoiceNo).trim());
    return {
      invoiceNo: r.invoiceNo || '',
      containerNo: r.containerNo || '',
      clientName: r.clientName || '',
      amount: num(r.due),
      outstanding: num(r.open),
      overdueDays: num(inv?.overdueDays),
      band: inv?.ageingBucket || '',
      period: String(r.month || '')
    };
  });

  if (client) {
    /* The Tally party name, not our client label — that is what the panel
       prints as "Tally party:", and what the figure below is measured on. */
    out.matchedParty = client.tally?.parties?.[0] || client.client || '';
    out.tallyOutstanding = num(client.tally?.outstanding ?? client.outstanding);
    /* `bills` kept for shape compatibility. A v1 invoice carries amount,
       received and outstanding separately, so a credit is no longer a
       negative "pending" the way a raw Tally bill was — a settled invoice is
       simply one with nothing left open. */
    out.bills = clientInvoices.map((i) => ({
      ref: i.invoiceNo || '',
      pending: num(i.outstanding),
      overdueDays: num(i.overdueDays),
      isReceipt: num(i.amount) < 0
    }));
  }

  out.containerShare = out.invoices.reduce((s, i) => s + i.amount, 0);
  out.containerOutstanding = out.invoices.reduce((s, i) => s + i.outstanding, 0);

  /* Which containers each of this client's invoices bills for.
   *
   * BUG FOUND AND FIXED 2026-11-17 ("TCKU2842760 yah container ke bhi sath
   * mai ho gye hai" — Luthra Projects has TWO containers, TCKU2842760 and a
   * site-cabin lease nicknamed "Site Cabin 52", and viewing either one's
   * Off-Lease record showed the OTHER's invoices too). Two things were
   * wrong:
   *
   *  1. This map was built ONLY from /lease-schedule?client=, which for
   *     Luthra has just 2 rows total (one per container, both Apr 2026-27) —
   *     none of the 12 older FY25-26 invoices that actually carry the
   *     outstanding. It ignored a second, more complete source: the client
   *     invoice's OWN `containerNo` field (confirmed populated on 22 of
   *     63Ideas Infolabs's 28 invoices, where the schedule alone covered only
   *     19) — folded in below.
   *  2. Below, any invoice NEITHER source named a container for got the
   *     container currently being viewed rubber-stamped onto it
   *     unconditionally. For a client with only one container that guess is
   *     harmless (there is nothing else it could be) — for Luthra's two, it
   *     meant BOTH containers' unattributed invoices got double-counted
   *     under whichever one you happened to open. Now gated on
   *     `client.containerCount <= 1`: the API's own count of how many
   *     containers this client has, so the guess only ever fires when there
   *     is no second container to confuse it with. An invoice this client
   *     has multiple containers for, that neither source attributes, is
   *     excluded from every container's view rather than guessed into one —
   *     wrong-but-plausible is worse here than visibly incomplete. */
  const containersByInvoice = new Map();
  const addContainer = (ref, cn) => {
    ref = String(ref || '').trim();
    cn = String(cn || '').trim();
    if (!ref || !cn) return;
    if (!containersByInvoice.has(ref)) containersByInvoice.set(ref, new Set());
    containersByInvoice.get(ref).add(cn);
  };
  for (const i of clientInvoices) addContainer(i.invoiceNo, i.containerNo);
  if (client?.clientKey) {
    try {
      const rows = await apiGet(`/lease-schedule?client=${encodeURIComponent(client.clientKey)}&limit=${PAGE_LIMIT}`);
      for (const r of (Array.isArray(rows) ? rows : [])) addContainer(r.invoiceNo, r.containerNo);
    } catch (e) {
      // The invoice table still renders without multi-container splits.
      logger.error('[ACCOUNTS-API] lease-schedule (client) failed:', e.message);
    }
  }

  const normId = (s) => String(s || '').trim().toUpperCase().replace(/\s+/g, ' ');
  const wantId = normId(containerNo);
  /* 0 containers (a client billed with nothing tied to any container) and 1
     both mean "no second container to confuse this with" — the field is
     missing on no client sampled, but a stale/missing value defaults to 0 via
     num(), which is deliberately on the safe (guess-allowed) side only
     because 0 carries the same "nothing else it could be" guarantee as 1. */
  const singleContainerClient = num(client?.containerCount) <= 1;

  /* Every client invoice, tagged with which container(s) it is actually for
     — real attribution first, the single-container guess only as a last
     resort — then kept ONLY if the container being viewed is one of them. */
  const scoped = clientInvoices
    .map((i) => {
      const ref = String(i.invoiceNo).trim();
      const known = containersByInvoice.get(ref);
      let containers = known ? [...known].sort() : [];
      /* No real attribution anywhere, but this client has only one
         container to begin with, so there is no ambiguity to resolve. */
      const partial = !containers.length && !!containerNo && singleContainerClient;
      if (partial) containers = [String(containerNo).trim()];
      return { invoice: i, containers, partial };
    })
    .filter((row) => row.containers.some((c) => normId(c) === wantId));

  /* INVOICE-WISE table — every one of THIS container's invoices with
     something still open, which is the set the Accounts & Collection app's
     own outstanding view shows for it. `amount` is the OPEN figure, not the
     billed one — Grand Total below sums this column. */
  out.invoiceTotals = scoped
    .filter((row) => num(row.invoice.outstanding) > 0)
    .map((row) => {
      const i = row.invoice;
      return {
        invoiceNo: String(i.invoiceNo).trim(),
        amount: num(i.outstanding),
        outstanding: num(i.outstanding),
        overdueDays: num(i.overdueDays),
        period: fmtPeriod(i.month, i.year),
        invoiceDate: String(i.billingDate || '').trim(),
        /* Always '' — /api/v1 publishes no document URL (see the file header).
           Both consumers fall back to the LMS's own Billing Sales file map. */
        invoiceUrl: '',
        containers: row.containers,
        containerCount: row.containers.length,
        consolidated: row.containers.length > 1,
        partial: row.partial
      };
    });

  /* THIS CONTAINER'S position — DR / CR / Net, summed only over the
     invoices just scoped to it. Deliberately NOT client.billed/received/
     outstanding any more: those are client-WIDE (confirmed they also include
     stray, invoice-untied receipts — Luthra Projects has a ₹23,320 receipt,
     RPT/584/23-24, attached to no invoice at all, which is exactly why
     summing this client's own invoices undershoots client.received by that
     same ₹23,320) and summing them was the other half of the same mixing
     bug this whole block fixes. A per-invoice-untied receipt cannot be
     credited to one container over another, so it is left out of every
     container's Net Balance rather than guessed into one. */
  out.receipts = scoped
    .filter((row) => num(row.invoice.amount) < 0)
    .map((row) => ({ ref: row.invoice.invoiceNo || '', amount: Math.abs(num(row.invoice.amount)), invoiceUrl: '' }));

  out.totalDr = scoped.reduce((s, row) => s + num(row.invoice.amount), 0);
  out.totalCr = scoped.reduce((s, row) => s + num(row.invoice.received), 0);
  out.netBalance = out.totalDr - out.totalCr;

  out.invoiceCount = out.invoiceTotals.length;
  out.grandTotal = out.invoiceTotals.reduce((s, i) => s + i.amount, 0);
  out.grandOutstanding = out.invoiceTotals.reduce((s, i) => s + i.outstanding, 0);

  /* Real money the fix above now deliberately leaves out: an open invoice for
     a multi-container client that NEITHER source (its own containerNo, nor
     the client-wide lease schedule) names a container for. Excluding it from
     every container's own view is the correct fix for the mixing bug (see
     the big comment above) — but silently excluding it would hide genuinely
     outstanding money with no trace. Surfaced instead as a plain count/total
     so the UI can say so, rather than implying this container's Grand Total
     is the client's whole picture. Always 0 for a single-container client —
     there, every open invoice was just attributed by the (safe) guess above. */
  if (!singleContainerClient) {
    const unattributed = clientInvoices.filter((i) => {
      const ref = String(i.invoiceNo).trim();
      return num(i.outstanding) > 0 && !containersByInvoice.has(ref);
    });
    /* The rows themselves, same shape as invoiceTotals (minus `containers` —
       there is, by construction, none to show), so the UI can render a real
       table here instead of a single summary line. "Explained in one
       sentence" was the first cut; the follow-up ask ("all data not show
       table format") was for the actual rows. */
    out.clientUnattributedInvoices = unattributed.map((i) => ({
      invoiceNo: String(i.invoiceNo).trim(),
      amount: num(i.outstanding),
      outstanding: num(i.outstanding),
      overdueDays: num(i.overdueDays),
      period: fmtPeriod(i.month, i.year),
      invoiceDate: String(i.billingDate || '').trim()
    }));
    out.clientUnattributedCount = unattributed.length;
    out.clientUnattributedOutstanding = unattributed.reduce((s, i) => s + num(i.outstanding), 0);
  } else {
    out.clientUnattributedInvoices = [];
    out.clientUnattributedCount = 0;
    out.clientUnattributedOutstanding = 0;
  }

  /* A container the schedule does not carry, for a client we could not match,
     is not an error worth showing — but a total blank with no explanation is
     worse than saying so. */
  if (!client && !out.error) {
    out.error = `No matching client in Accounts & Collection for "${clientName || containerNo}"`;
  }
  return out;
}
