/**
 * Shared Deployed Summary Excel builder — used by BOTH the scheduled digest
 * email (deployedSummaryDigest.service.js) and the on-demand download
 * endpoint (dashboard.controller.js's getDeployedSummaryExport, behind the
 * frontend's own "Export to Excel" button). Extracted 2026-10-27 — explicit
 * request ("highlight nahi dikh raha hai color mai"): the frontend button
 * built its file client-side with the browser `xlsx` package, which
 * silently drops any cell style on write (same limitation documented in
 * deployedSummaryDigest.service.js's own header — confirmed by a
 * round-trip test), so none of the yellow/red highlighting below ever
 * actually showed up in that file. Rather than trying to get exceljs
 * working in a Vite/browser bundle, the frontend button now just downloads
 * this exact SERVER-built file — the same one the email sends, so the two
 * can never show different numbers or drift apart.
 */
import ExcelJS from 'exceljs';
import { getDeployedSummaryData, getDeployedDetailData, getOffLeasedWithFinalBillingDue } from './dashboard.service.js';
import { monthKeyOf, previousMonthKey, saveDeployedSheetSnapshotIfNeeded, diffDeployedSnapshots } from './deployedSheetSnapshot.service.js';

export const SUMMARY_GROUPS = [
  ['opening', 'Opening Deployed'],
  ['addition', 'Addition'],
  ['deletion', 'Deletion'],
  ['net', 'Net Movement'],
  ['closing', 'Closing Deployed'],
];

const CONTAINER_HEADERS = [
  'Container', 'Order No', 'Client Code', 'Client Name', 'Size', 'Type',
  'Billing Type', 'PO No', 'PO Validity', 'Agreement PDF', 'PO PDF', 'Location', 'Deployed Date', 'Valid Upto', 'Movement', 'Last Updated', 'Final Billing Date'
];

function containerToRow(c) {
  return [
    c.container, c.orderNo, c.clientCode, c.clientName, c.size, c.type,
    c.billingType, c.poNo, c.poValidity, c.agreementUrl, c.poAttachment, c.location, c.deployedDate, c.validUpto, c.movement || '', c.lastUpdated, c.finalBillingDate || ''
  ];
}

const RECENT_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF59D' } }; // soft yellow
const FINAL_BILLING_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEF9A9A' } }; // soft red
const ADDED_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC8E6C9' } }; // soft green — new lease / addition
const REMOVED_FILL = FINAL_BILLING_FILL; // soft red — off-lease / removed (same color family, same meaning: left the fleet)
const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };

/** Excel sheet names: <=31 chars, no \ / ? * [ ] :  — a Billing Type value
 *  from the live sheet could contain any of these in principle. */
function safeSheetName(name) {
  return String(name || 'Unspecified').replace(/[\\/?*[\]:]/g, '-').slice(0, 31) || 'Unspecified';
}

/** Default per-row fill: yellow for a recent app-side update, red for an
 *  off-leased container still due Final Billing — see getDeployedDetailData/
 *  getOffLeasedWithFinalBillingDue's own doc comments. Used by the main
 *  "Deployed Containers" sheet and the All-Categories Opening/Closing
 *  sheets; Addition/Deletion/Net below use a DIFFERENT scheme instead (see
 *  buildMonthAllCategoriesExcel) — explicit request 2026-10-27 ("offlease
 *  red col karo and jo new lease green col row hona chahiye hai"): every
 *  row on the Addition sheet IS a new lease (flat green), every row on
 *  Deletion IS an off-lease (flat red) — their own sheet identity already
 *  says so, so per-row yellow/red there would be redundant/confusing. */
function defaultFillFor(c) {
  return c.finalBillingDue ? FINAL_BILLING_FILL : (c.recentlyUpdated ? RECENT_FILL : null);
}

function addContainersSheet(wb, title, containers, fillFor = defaultFillFor) {
  const ws = wb.addWorksheet(title);
  ws.addRow(CONTAINER_HEADERS).eachCell((cell) => { cell.font = { bold: true }; cell.fill = HEADER_FILL; });
  for (const c of containers) {
    const row = ws.addRow(containerToRow(c));
    const fill = fillFor(c);
    if (fill) row.eachCell((cell) => { cell.fill = fill; });
  }
  ws.columns.forEach((col) => { col.width = 16; });
  return ws;
}

const CHANGES_HEADERS = ['Container', 'Client Name', 'Change Type', 'Field', 'Old Value', 'New Value'];

/** Container No -> Client Name lookup, built from the diff's own `row`s
 *  (col 1 = Client Name on the Deployed sheet). */
function clientNameOf(row) {
  return String(row?.[1] ?? '').trim();
}

/**
 * "Changes vs <prev month>" sheet — one row per container+field that
 * actually changed between last month's snapshot and this month's, plus
 * rows for any container newly appeared or dropped off the sheet entirely.
 * Green = added, red = removed, no fill = a field on an existing row
 * changed. If there's no previous month's snapshot yet, a single
 * explanatory row is written instead of silently omitting the sheet.
 */
function addChangesSheet(wb, diff) {
  const ws = wb.addWorksheet(safeSheetName(`Changes vs ${diff.ok ? diff.oldMonthKey : 'last month'}`));
  ws.addRow(CHANGES_HEADERS).eachCell((cell) => { cell.font = { bold: true }; cell.fill = HEADER_FILL; });

  if (!diff.ok) {
    ws.addRow(['', '', '', diff.reason, '', '']);
    ws.columns.forEach((col) => { col.width = 18; });
    return ws;
  }

  for (const { container, row } of diff.added) {
    ws.addRow([container, clientNameOf(row), 'ADDED', '', '', '']).eachCell((cell) => { cell.fill = ADDED_FILL; });
  }
  for (const { container, row } of diff.removed) {
    ws.addRow([container, clientNameOf(row), 'REMOVED', '', '', '']).eachCell((cell) => { cell.fill = REMOVED_FILL; });
  }
  for (const { container, row, fieldChanges } of diff.changed) {
    const clientName = clientNameOf(row);
    for (const fc of fieldChanges) {
      ws.addRow([container, clientName, 'CHANGED', fc.header, fc.from, fc.to]);
    }
  }
  ws.columns.forEach((col) => { col.width = 18; });
  return ws;
}

export async function buildWorkbookBuffer(data, containers, diff) {
  const wb = new ExcelJS.Workbook();

  const summaryWs = wb.addWorksheet('Summary');
  summaryWs.addRow(['Category', ...data.months]).eachCell((cell) => { cell.font = { bold: true }; cell.fill = HEADER_FILL; });
  for (const [key, label] of SUMMARY_GROUPS) {
    summaryWs.addRow([label, ...data.rows.map((r) => r[key].total)]);
  }
  summaryWs.columns.forEach((col) => { col.width = 14; });

  addContainersSheet(wb, 'Deployed Containers', containers);

  // One sheet per distinct Billing Type value actually present this month,
  // grouped case-INSENSITIVELY (live data has both "end" and "End") because
  // Excel itself treats sheet names case-insensitively for uniqueness.
  const byBillingType = new Map(); // normalized (lowercase) key -> { label, containers }
  for (const c of containers) {
    const raw = (c.billingType || '').trim();
    const normKey = raw.toLowerCase() || 'unspecified';
    if (!byBillingType.has(normKey)) {
      const label = raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : 'Unspecified';
      byBillingType.set(normKey, { label, containers: [] });
    }
    byBillingType.get(normKey).containers.push(c);
  }
  for (const { label, containers: list } of [...byBillingType.values()].sort((a, b) => a.label.localeCompare(b.label))) {
    addContainersSheet(wb, safeSheetName(`Billing - ${label}`), list);
  }

  addChangesSheet(wb, diff);

  return wb.xlsx.writeBuffer();
}

/**
 * Gathers all the data for "today" (data.rows[0] — the Deployed Summary
 * data is already built latest-month-first, so this always reflects the
 * CURRENT month) and builds the full workbook. The one function the
 * scheduled email and the on-demand download endpoint both call, so they
 * can never show different numbers.
 *
 * @param {object} [opts]
 * @param {Date} [opts.now] - override "today" (only affects which month's
 *   snapshot gets saved/compared — the report itself always follows the
 *   live data's own latest row).
 */
export async function buildDeployedSummaryExcel({ now } = {}) {
  const today = now ? new Date(now) : new Date();

  const data = await getDeployedSummaryData();
  const latest = data.rows[0];
  if (!latest) throw new Error('No Deployed Summary data available');

  const { containers: deployedContainers } = await getDeployedDetailData(latest.month, 'closing', null, null);
  // Off-leased containers whose Final Billing Date is this month or any
  // later month (not yet passed) — appended, not merged into the primary
  // list's own count anywhere else (see getOffLeasedWithFinalBillingDue's
  // own doc comment for why).
  const { containers: finalBillingContainers } = await getOffLeasedWithFinalBillingDue(latest.month);
  const containers = [...deployedContainers, ...finalBillingContainers];
  const recentCount = deployedContainers.filter((c) => c.recentlyUpdated).length;
  const finalBillingCount = finalBillingContainers.length;

  // Real month-over-month diff. Saves today's snapshot first (idempotent
  // per month) so this call's own data is captured even if the dedicated
  // 9:05 AM cron hasn't fired yet today, then diffs against last month's.
  await saveDeployedSheetSnapshotIfNeeded(today);
  const currentMonthKey = monthKeyOf(today);
  const diff = await diffDeployedSnapshots(previousMonthKey(currentMonthKey), currentMonthKey);

  const buffer = await buildWorkbookBuffer(data, containers, diff);
  const filename = `Deployed-Summary-${latest.month.replace(/\s+/g, '-')}.xlsx`;

  return { buffer, filename, data, latest, containers, recentCount, finalBillingCount, diff };
}

/**
 * "All Categories" for one month — one sheet per movement category
 * (Opening/Addition/Deletion/Net/Closing), matching the frontend page's own
 * per-month "Export to Excel" menu item (DeployedSummaryPage.jsx's
 * exportMonthAll). Added 2026-10-27 alongside the main export above for the
 * same reason — the client-side build (browser `xlsx` package) couldn't
 * show the yellow/red highlighting either, confirmed by the user pointing
 * at exactly this file ("Deployed-Oct-2026-All-Categories...").
 *
 * The Final Billing Date red-highlight rows (getOffLeasedWithFinalBillingDue
 * — off-leased containers, not part of any of these 5 movement categories
 * by definition) are only added to the Closing sheet, matching the main
 * export's own placement — adding them to Opening/Addition/Deletion/Net too
 * would be misleading (those categories specifically track containers
 * still in or moving through the deployed pool).
 */
export async function buildMonthAllCategoriesExcel(monthLabel, { typeVal, sizeVal } = {}) {
  const results = await Promise.all(
    SUMMARY_GROUPS.map(([key]) => getDeployedDetailData(monthLabel, key, typeVal || null, sizeVal || null))
  );
  const { containers: finalBillingContainers } = await getOffLeasedWithFinalBillingDue(monthLabel);

  // Explicit request 2026-10-27 ("offlease red col karo and jo new lease
  // green col row hona chahiye hai"): Addition is flat green (every row
  // there is, by definition, a newly-deployed/new-lease container this
  // month), Deletion is flat red (every row is an off-lease this month),
  // Net mixes the two so it colors per-row by each one's own `movement`
  // field. Opening/Closing keep the default yellow-recent/red-final-billing
  // scheme (see defaultFillFor) since those aren't all one movement type.
  const FILL_BY_CATEGORY = {
    addition: () => ADDED_FILL,
    deletion: () => REMOVED_FILL,
    net: (c) => (c.movement === 'Addition' ? ADDED_FILL : c.movement === 'Deletion' ? REMOVED_FILL : null)
  };

  const wb = new ExcelJS.Workbook();
  SUMMARY_GROUPS.forEach(([key, label], i) => {
    const containers = results[i]?.containers || [];
    const withExtras = key === 'closing' ? [...containers, ...finalBillingContainers] : containers;
    addContainersSheet(wb, safeSheetName(label), withExtras, FILL_BY_CATEGORY[key]);
  });

  const buffer = await wb.xlsx.writeBuffer();
  const filename = `Deployed-${monthLabel.replace(/\s+/g, '-')}-All-Categories.xlsx`;
  return { buffer, filename };
}
