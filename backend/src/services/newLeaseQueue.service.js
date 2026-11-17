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

/** Appends the new deployment to TWO places: the Deployed sheet gets only
 *  its own native 18 columns (see buildDeployedRow); the fuller record —
 *  every field this form captures, including GST/Cancelled Cheque/
 *  Transportation — goes to its own sheet, SHEETS.NEW_LEASE_REQUEST. The
 *  queue entry's old snapshot/row is never touched. Marks the queue entry
 *  'done' only after both appends actually succeed. */
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
  await appendRow(SHEETS.DEPLOYED, deployedRow);
  // Mirror immediately — same "don't make the caller wait for the next
  // reconcile cycle" reasoning addToOffLeaseTracking's own mirror block uses.
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
  await _ensureNewLeaseRequestSheet();
  await appendRow(SHEETS.NEW_LEASE_REQUEST, requestRow);
  await appendMongoMirrorRow(SHEETS.NEW_LEASE_REQUEST, requestRow);

  await col.updateOne(
    { _id: doc._id },
    { $set: { status: 'done', completedAt: new Date(), completedBy: userEmail || '' } }
  );
  return 'OK';
}
