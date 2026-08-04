import * as offLeaseService from '../services/offlease.service.js';
import { assertRolesAdmin } from '../services/roles.service.js';

/* ---- Core 8-stage pipeline ---- */

export async function getData(req, res) {
  const stage = parseInt(req.query.stage, 10);
  res.json(await offLeaseService.getOffLeaseData(stage));
}

export async function getStageDetail(req, res) {
  const stage = parseInt(req.params.stage, 10);
  res.json(await offLeaseService.getOffLeaseStageDetail(req.params.containerNo, stage));
}

export async function saveStage(req, res) {
  const stage = parseInt(req.params.stage, 10);
  // Permission for this stage (offlease1..offlease8) is checked inside the
  // service, since it's derived from the :stage route param at request time.
  const message = await offLeaseService.saveOffLeaseStage(req.params.containerNo, stage, req.body || {}, req.user.email);
  res.json({ message });
}

export async function nextLeaseId(req, res) {
  res.json({ leaseId: await offLeaseService.getNextLeaseId() });
}

/* ---- Pending Approval queue ---- */

export async function getApprovalData(req, res) {
  res.json(await offLeaseService.getOffLeaseApprovalData());
}

export async function saveApprovalAction(req, res) {
  const { status } = req.body;
  // Permission ('offleaseapproval') is checked inside the service.
  const message = await offLeaseService.saveOffLeaseApprovalAction(req.params.containerNo, status, req.user.email);
  res.json({ message });
}

/* ---- Dashboard container lookup ---- */

export async function getContainerDetail(req, res) {
  res.json(await offLeaseService.getOffLeaseContainerDetail(req.params.containerNo));
}

export async function getDashboardData(req, res) {
  res.json(await offLeaseService.getOffLeaseDashboardData());
}

/* ---- Tracking-sheet bootstrap ---- */

export async function addToTracking(req, res) {
  const { containerNo } = req.body;
  const message = await offLeaseService.addToOffLeaseTracking(containerNo);
  res.json({ message });
}

/* ---- Admin-only: one-time maintenance / repair tools + diagnostics ---- */

export async function runCopyApprovedData(req, res) {
  assertRolesAdmin(req.user.email);
  await offLeaseService.copyApprovedData();
  res.json({ message: 'OK' });
}

export async function dumpHeaders(req, res) {
  assertRolesAdmin(req.user.email);
  res.json({ message: await offLeaseService.dumpOffLeaseTrackingHeaders() });
}

export async function restoreHeaderRow(req, res) {
  assertRolesAdmin(req.user.email);
  res.json({ message: await offLeaseService.restoreOffLeaseHeaderRowFromLatestBackup() });
}

export async function fixEmailCollision(req, res) {
  assertRolesAdmin(req.user.email);
  res.json({ message: await offLeaseService.fixQuotationEmailMarkedCollision() });
}

export async function reorderColumns(req, res) {
  assertRolesAdmin(req.user.email);
  res.json({ message: await offLeaseService.reorderOffLeaseTrackingColumns() });
}

export async function fixStageHeaders(req, res) {
  assertRolesAdmin(req.user.email);
  res.json({ message: await offLeaseService.fixOffLeaseStageHeaders() });
}

export async function debugOrderNos(req, res) {
  assertRolesAdmin(req.user.email);
  res.json({ message: await offLeaseService.debugOrderNosForContainer(req.params.containerNo) });
}

export async function traceOrder(req, res) {
  assertRolesAdmin(req.user.email);
  res.json({ message: await offLeaseService.traceOrderNo(req.params.containerNo) });
}

export async function feedsNewLeaseReff(req, res) {
  assertRolesAdmin(req.user.email);
  res.json({ message: await offLeaseService.whatFeedsNewLeaseReff() });
}

export async function feedsAllSheets(req, res) {
  assertRolesAdmin(req.user.email);
  res.json({ message: await offLeaseService.whatFeedsAllSheets() });
}
