import * as dashboardService from '../services/dashboard.service.js';
import { buildDeployedSummaryExcel, buildMonthAllCategoriesExcel } from '../services/deployedSummaryExcel.service.js';
import { addPoAgreementHistoryEntry } from '../services/poAgreementHistory.service.js';

export async function getDeployedSummary(req, res) {
  res.json(await dashboardService.getDeployedSummaryData());
}

/** GET /dashboard/deployed-summary/export — explicit request 2026-10-27
 *  ("highlight nahi dikh raha hai color mai"): the frontend's own "Export
 *  to Excel" button used to build its file client-side with the browser
 *  `xlsx` package, which can't write cell colors (confirmed by a
 *  round-trip test — see deployedSummaryExcel.service.js's own header
 *  comment). This returns the exact same server-built, already-highlighted
 *  file the scheduled digest email sends, as a download. */
export async function getDeployedSummaryExport(req, res) {
  const { buffer, filename } = await buildDeployedSummaryExcel({});
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(Buffer.from(buffer));
}

/** GET /dashboard/deployed-summary/export-month-categories?month=...&type=&size=
 *  — the "All Categories" per-month export (Opening/Addition/Deletion/Net/
 *  Closing, one sheet each), matching the exact file the user flagged
 *  ("Deployed-Oct-2026-All-Categories..."). Same fix/reason as
 *  getDeployedSummaryExport above. */
export async function getDeployedSummaryExportMonthCategories(req, res) {
  const { month, type, size } = req.query;
  const { buffer, filename } = await buildMonthAllCategoriesExcel(month, { typeVal: type, sizeVal: size });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(Buffer.from(buffer));
}

export async function getDeployedDetail(req, res) {
  const { month, category, type, size } = req.query;
  res.json(await dashboardService.getDeployedDetailData(month, category, type, size));
}

export async function getPoAgreementTracker(req, res) {
  res.json(await dashboardService.getPoAgreementTrackerData());
}

/** POST /dashboard/po-agreement-tracker/history — explicit request
 *  2026-11-04 (backfill form, see poAgreementHistory.service.js's own
 *  header comment). req.user.email is the "entered by" — never trusted
 *  from the request body, same convention every other save in this app
 *  uses for its own actor field. */
export async function addPoAgreementHistory(req, res) {
  const { containerNo, leaseId, clientName, type, startDate, endDate, fileUrl, poNo } = req.body;
  const entry = await addPoAgreementHistoryEntry({
    containerNo, leaseId, clientName, type, startDate, endDate, fileUrl, poNo,
    enteredBy: req.user?.email || ''
  });
  res.json({ message: 'SAVED', entry });
}
