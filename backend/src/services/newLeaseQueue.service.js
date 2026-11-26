/**
 * "New Lease" queue — explicit request 2026-11-16 ("location change click
 * check box agar yah click karuga tabhi new lease navigatio add karo fir
 * yaha pending dikhega"): the Lease Expiry "Off-Lease Container" modal's
 * own Location Change checkbox (OffLeaseModal.jsx) queues the container
 * here instead of touching the Deployed sheet directly. The OLD Deployed
 * row stays exactly as the Off-Lease action already left it ("Off-Lease"
 * status) — this queue only ever APPENDS a brand-new row once someone
 * fills in the new deployment's own details, never edits the old one.
 *
 * Mongo-only bookkeeping (collection `_new_lease_queue`, same "_"-prefixed,
 * no-Sheets-mirror convention as `_api_keys`/`_sla_alerts`) — this is
 * operational queue state, not business data, so it never needs a Sheets
 * mirror of its own.
 */
import { ObjectId } from 'mongodb';
import { getCollection } from './mongo.service.js';
import { appendRow, insertSheetIfMissing } from './googleSheets.service.js';
import { appendMongoMirrorRow } from './mongoSheetData.service.js';
import { SHEETS } from '../config/sheets.config.js';
import { safeStr } from '../utils/format.js';
import { AppError, notFound } from '../utils/AppError.js';
import { sendMail } from './email.service.js';
import { notificationEmailForSalePerson } from './salePersonAccess.service.js';
import { enqueueSheetReplay } from './outbox.service.js';

const COLLECTION = '_new_lease_queue';

/* BUG FOUND AND FIXED 2026-11-16 (explicit correction, "ek new sheet pe
 * jayega and deployed sheet mai jo jo hai unke hi jayega" — this used to
 * bolt GST/Cancelled Cheque/Transportation Scope/Transportation PO onto
 * the Deployed sheet as new, hand-added columns. Reversed: the Deployed
 * sheet now only ever gets the columns it already, natively has (see
 * DEPLOYED_FIELD_ORDER below) — every field this form added BEYOND that
 * (GST, Cancelled Cheque, Transportation Scope/PO) goes to its own new
 * sheet, SHEETS.NEW_LEASE_REQUEST, alongside a full copy of the Deployed
 * fields too, for one complete record in one place. */
const NEW_LEASE_REQUEST_HEADERS = [
  'Container No', 'Customer Name', 'Size', 'Type', 'Location', 'City',
  'Deployed Date', 'Agreement Valid Upto', 'Agreement PDF', 'Sale Person',
  'PO', 'PO PDF', 'PO Validity', 'Rate', 'Billing Cycle', 'Client Code',
  'Billing Type', 'Product Code',
  'GST', 'Cancelled Cheque', 'Transportation Scope', 'Transportation PO',
  'Old Client Name', 'Old Location', 'Old Valid Upto',
  'Submitted By', 'Submitted At'
];
let newLeaseRequestSheetEnsured = false;
async function _ensureNewLeaseRequestSheet() {
  if (newLeaseRequestSheetEnsured) return;
  newLeaseRequestSheetEnsured = true;
  await insertSheetIfMissing(SHEETS.NEW_LEASE_REQUEST, NEW_LEASE_REQUEST_HEADERS);
}

/** Called right after a Location Change off-lease succeeds — `oldSnapshot`
 *  is that container's own Deployed row as it stood at that moment, kept
 *  purely for reference display (never written back anywhere). */
export async function addToNewLeaseQueue(containerNo, oldSnapshot, userEmail) {
  await getCollection(COLLECTION).insertOne({
    containerNo: safeStr(containerNo),
    oldSnapshot: oldSnapshot || null,
    status: 'pending',
    createdAt: new Date(),
    createdBy: userEmail || ''
  });
}

function toPublicShape(doc) {
  return {
    id: String(doc._id),
    containerNo: doc.containerNo,
    oldSnapshot: doc.oldSnapshot,
    createdAt: doc.createdAt,
    createdBy: doc.createdBy
  };
}

/** Pending list — the "New Lease" sidebar page's own data source. */
export async function listNewLeaseQueue() {
  const docs = await getCollection(COLLECTION).find({ status: 'pending' }).sort({ createdAt: -1 }).toArray();
  return docs.map(toPublicShape);
}

/** Pending count — the sidebar nav badge (see tasks.service.js's own
 *  newLeasePending key). Never throws — a count failure should not break
 *  the whole My Task aggregate. */
export async function countNewLeaseQueuePending() {
  try {
    return await getCollection(COLLECTION).countDocuments({ status: 'pending' });
  } catch (e) {
    return 0;
  }
}

/** Explicit request 2026-11-25 ("yah new lease se hathana hai kaise hathau
 *  bato" — a queued entry that shouldn't have been queued, e.g. a mistaken
 *  Location Change tick on the Off-Lease modal). Soft-marked 'cancelled',
 *  same "never hard-delete, keep an audit trail" convention the rest of
 *  this app's own soft-delete paths already use — the Deployed/New Lease
 *  Request sheets are never touched either way, since nothing was ever
 *  written to them for a still-pending entry. */
export async function cancelNewLeaseEntry(id, userEmail) {
  const col = getCollection(COLLECTION);
  let doc;
  try {
    doc = await col.findOne({ _id: new ObjectId(id) });
  } catch (e) {
    throw new AppError('Invalid New Lease queue entry id.');
  }
  if (!doc) throw notFound('New Lease queue entry');
  if (doc.status !== 'pending') return 'ALREADY_PROCESSED';

  await col.updateOne(
    { _id: doc._id },
    { $set: { status: 'cancelled', cancelledAt: new Date(), cancelledBy: userEmail || '' } }
  );
  return 'OK';
}

/* Deployed sheet's own column order (SHEETS.DEPLOYED, confirmed live
 * 2026-11-16) — a brand-new row only ever fills these 18 identity/lease
 * columns, its OWN native schema, nothing more; everything past col 18
 * (renewal/approval history) is populated later through the normal Renew
 * & Document flow, same as any other freshly-added Deployed row. */
const DEPLOYED_ROW_WIDTH = 18;

function buildDeployedRow(payload, fallbackContainerNo) {
  const newRow = new Array(DEPLOYED_ROW_WIDTH).fill('');
  newRow[0] = safeStr(payload.containerNo || fallbackContainerNo);
  newRow[1] = safeStr(payload.customerName);
  newRow[2] = safeStr(payload.size);
  newRow[3] = safeStr(payload.type);
  newRow[4] = safeStr(payload.location);
  newRow[5] = safeStr(payload.city);
  newRow[6] = safeStr(payload.deployedDate);
  newRow[7] = safeStr(payload.agreementValidUpto);
  newRow[8] = safeStr(payload.agreementPdf);
  newRow[9] = safeStr(payload.salePerson);
  newRow[10] = safeStr(payload.po);
  newRow[11] = safeStr(payload.poPdf);
  newRow[12] = safeStr(payload.poValidity);
  const rate = Number(String(payload.rate ?? '').trim());
  newRow[13] = Number.isFinite(rate) && String(payload.rate ?? '').trim() !== '' ? rate : '';
  newRow[14] = safeStr(payload.billingCycle);
  newRow[15] = safeStr(payload.clientCode);
  newRow[16] = safeStr(payload.billingType);
  newRow[17] = safeStr(payload.productCode);
  return newRow;
}

/** Fixed recipients every New Lease submission notifies — same 3 desks
 *  (Pushpa, Shivani, Mansi) the other Off-Lease/Lease digests already copy
 *  (see e.g. offlease.service.js's OL_STAGE3_EMAIL_CC,
 *  deployedSummaryDigest.service.js's REPORT_RECIPIENTS). The 4th recipient,
 *  the Sale Executive, is resolved per-submission from the form's own Sale
 *  Person field below — not fixed, since it's a different person every time. */
const NEW_LEASE_FIXED_RECIPIENTS = [
  'pushpa.shetty@crystalgroup.in', 'shivani.dhall@crystalgroup.in', 'mansi.agarwal@crystalgroup.in'
];

/** Explicit request 2026-11-25 ("jaise hi yah new lease form fill hoga woh
 *  uska full data... mail jana chahiye pushpa shivani sale exctuive and
 *  mansi pc ko") — every field this form captured (the same full record
 *  NEW_LEASE_REQUEST_HEADERS/requestRow already hold, nothing summarized or
 *  left out) goes out the moment a submission completes. Best-effort: a
 *  mail failure must never undo or fail the submission itself, same
 *  "additive, never blocking" posture _buildContainerStageTatMap/
 *  computeContainerSla already use elsewhere in Off-Lease for their own
 *  non-critical enrichments. */
async function _sendNewLeaseSubmittedEmail(containerNo, requestRow, payload) {
  try {
    const salePersonEmail = notificationEmailForSalePerson(payload.salePerson);
    const to = [...NEW_LEASE_FIXED_RECIPIENTS, salePersonEmail].filter(Boolean).join(',');

    const th = (s) => `<th style="padding:6px 10px;border:1px solid #ddd;background:#f4f4f4;font-size:12.5px;text-align:left;white-space:nowrap;">${s}</th>`;
    const td = (s) => `<td style="padding:6px 10px;border:1px solid #ddd;font-size:12.5px;">${s || '-'}</td>`;
    const rows = NEW_LEASE_REQUEST_HEADERS.map((label, i) => `<tr>${th(label)}${td(safeStr(requestRow[i]))}</tr>`).join('');

    const subject = `New Lease Submitted – ${containerNo}`;
    const html = `<p>A New Lease form has been filled for <strong>${containerNo}</strong>.</p>`
      + `<table style="border-collapse:collapse;">${rows}</table>`;
    const body = NEW_LEASE_REQUEST_HEADERS.map((label, i) => `${label}: ${safeStr(requestRow[i]) || '-'}`).join('\n');

    await sendMail({ to, subject, body, html });
  } catch (e) {
    console.error(`[NEW-LEASE-EMAIL] send failed for ${containerNo} (non-fatal):`, e?.message || e);
  }
}

/** MONGO-FIRST — explicit, repeated request 2026-11-25 ("as soon as they
 *  give us the form it should... submit the form within a second or two and
 *  after submitting the form it should get stored in the mongo DB and if
 *  the sheet API limit is hit then there should be a sync which will fill
 *  the sheet afterwards... the user should not be able to see this error"),
 *  live-confirmed on THIS exact form ("Google Sheets API rate limit was hit"
 *  on New Lease's own Submit). Both live Sheets appends (Deployed +
 *  NEW_LEASE_REQUEST, including the insertSheetIfMissing check ahead of the
 *  second one) are the slow, rate-limit-exposed part — moved entirely into
 *  completeNewLeaseEntrySheetWrite below, replayed later by the outbox
 *  worker. Everything the caller actually needs (both Mongo mirrors
 *  written, the queue entry marked done, the notification email sent) still
 *  happens synchronously, so the page reflects the new deployment
 *  immediately — only the live-Sheets round trip is deferred. Same
 *  Mongo-first/outbox-replay pattern as offlease.service.js's
 *  addToOffLeaseTrackingFast/addToOffLeaseTrackingSheetWrite pair. */
export async function completeNewLeaseEntry(id, payload, userEmail) {
  const col = getCollection(COLLECTION);
  let doc;
  try {
    doc = await col.findOne({ _id: new ObjectId(id) });
  } catch (e) {
    throw new AppError('Invalid New Lease queue entry id.');
  }
  if (!doc) throw notFound('New Lease queue entry');
  if (doc.status !== 'pending') return 'ALREADY_PROCESSED';

  const deployedRow = buildDeployedRow(payload, doc.containerNo);
  await appendMongoMirrorRow(SHEETS.DEPLOYED, deployedRow);

  const old = doc.oldSnapshot || {};
  const transportCrystalScope = payload.transportationScope === 'Crystal Scope';
  const requestRow = [
    ...deployedRow,
    safeStr(payload.gst),
    safeStr(payload.cancelledCheque),
    safeStr(payload.transportationScope),
    // PO only meaningful once Crystal Scope is picked — Client Scope means
    // transport (and its PO) is the client's own arrangement, not ours.
    transportCrystalScope ? safeStr(payload.transportationPo) : '',
    safeStr(old.clientName), safeStr(old.location), safeStr(old.validUpto),
    userEmail || '', new Date().toISOString()
  ];
  await appendMongoMirrorRow(SHEETS.NEW_LEASE_REQUEST, requestRow);

  await col.updateOne(
    { _id: doc._id },
    { $set: { status: 'done', completedAt: new Date(), completedBy: userEmail || '' } }
  );

  await enqueueSheetReplay('newLeaseQueue.completeNewLeaseEntrySheetWrite', [deployedRow, requestRow], { actor: userEmail });

  await _sendNewLeaseSubmittedEmail(doc.containerNo, requestRow, payload);

  return 'OK';
}

/** The outbox replay target for completeNewLeaseEntry above (registered in
 *  jobs/outboxRegistry.js) — the real live-Sheets writes only, both rows
 *  already saved to their Mongo mirrors by the fast path above. */
export async function completeNewLeaseEntrySheetWrite(deployedRow, requestRow) {
  await appendRow(SHEETS.DEPLOYED, deployedRow);
  await _ensureNewLeaseRequestSheet();
  await appendRow(SHEETS.NEW_LEASE_REQUEST, requestRow);
}
