import { apiClient } from '../shared/auth/index.js';

/** Deployed containers summary: opening/addition/deletion/net/closing per month. */
export const getDeployedSummary = () => apiClient.get('/dashboard/deployed-summary').then((r) => r.data);

/** Container-level drill-down for one deployed-summary month/category/type/size cell. */
export const getDeployedDetail = (month, category, type, size) =>
  apiClient.get('/dashboard/deployed-detail', { params: { month, category, type, size } }).then((r) => r.data);

/** Every deployed container's Agreement Valid Upto / PO Validity dates, for the PO & Agreement Tracker page. */
export const getPoAgreementTracker = () => apiClient.get('/dashboard/po-agreement-tracker').then((r) => r.data);

/** Server-built Deployed Summary Excel file (Summary / Deployed Containers /
 *  one sheet per Billing Type / Changes vs last month), with real cell
 *  highlighting — explicit request 2026-10-27 ("highlight nahi dikh raha hai
 *  color mai"): the old client-side build (xlsx package) couldn't write
 *  cell colors at all; this is the exact same file the scheduled digest
 *  email sends, so the two never show different numbers. Returns the raw
 *  response (not .data) — the caller needs both the blob and the filename
 *  the server chose (Content-Disposition). */
export const getDeployedSummaryExport = () => apiClient.get('/dashboard/deployed-summary/export', { responseType: 'blob' });

/** Same server-built, highlighted file as above, but the "All Categories"
 *  per-month variant (Opening/Addition/Deletion/Net/Closing as separate
 *  sheets) — matches the frontend's per-month-column "Export to Excel"
 *  menu item. */
export const getDeployedSummaryExportMonthCategories = (month, type, size) =>
  apiClient.get('/dashboard/deployed-summary/export-month-categories', { params: { month, type, size }, responseType: 'blob' });
