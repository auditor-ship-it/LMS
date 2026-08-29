/**
 * Sheet-tab name constants and external spreadsheet IDs.
 * Ported verbatim from LMS.js / api.js literals — do not rename tabs here,
 * the live spreadsheet's tab names must match exactly.
 */

// Tabs in the main spreadsheet (env.googleSheetId)
export const SHEETS = {
  NEW_LEASE: 'New Lease',
  DEPLOYED: 'Deployed sheet',
  OPERATION: 'Operation sheet',
  BILLING_SALES: 'Billing Sales',
  RECEIVABLES: 'Receivables',
  RENEWAL_LOG: 'Renewal Log',
  OFF_LEASE_TRACKING: 'Off-Lease Tracking',
  DISPUTE_APPROVAL: 'Dispute Approval',
  APPROVE_BILLING: 'New Lease Other Order type',
  BILLING_CATEGORY: 'Approve billing for invoice',
  RECEIVABLE_CATEGORY: 'Receivables other order Type',
  TRANSPORTION: 'Transportion',
  CONTROL: 'Control',
  CLIENT_DB: 'Client Db',
  NEW_LEASE_REFF: 'New lease reff',
  TEAM_ACCOUNTS: 'Team Accounts',
  SIDEBAR_ACCESS: 'Sidebar Access',
  ROLE_PERMISSIONS_LEGACY: 'Role Permissions', // migration-only, read once then unused
  USER: 'USER',
  MASTER_SHEET: 'Master Sheet',
  CONTAINER_MASTER_LOGS: 'container_master_logs',
  /* Stage 9 container-movement log. Unlike Stage 1-8, which fill columns on
     the container's existing Off-Lease Tracking row, Stage 9 is append-only:
     one row per movement, so the same container can be logged many times.
     Created on first use by stage9.service.js — it is not one of the tabs the
     port inherited, so it may not exist in the live spreadsheet yet. */
  STAGE9_MOVEMENT: 'Stage 9 Movement',
  /* External FMS workbook tabs (EXTERNAL_SPREADSHEETS.CONSOLIDATE below) —
   * NOT this app's own "Stage 9 Movement" log above (different sheet,
   * different workbook, unrelated names). Mirrored into Mongo 2026-08-28 —
   * see mongoSheetMapping.js's entries for these three and
   * stage8.service.js, which reads them exclusively from that mirror now. */
  FMS_STAGE8: 'STAGE-8',
  FMS_STAGE9: 'STAGE-9',
  FMS_STAGE10: 'STAGE-10',
  /* Dashboard live-comment thread, append-only, one row per remark. Separate
     from the stage remark columns, which belong to a stage and freeze when it
     completes. Created on first use by offleaseRemarks.service.js. */
  OFF_LEASE_REMARKS: 'Off-Lease Remarks',
  /* Stage 2 "Move To Stage" / "Send Back" audit trail, append-only, one row
     per event (MOVED or SENT_BACK) — never overwritten, so a record's full
     movement history survives a Send Back even though the live Off-Lease
     Tracking row's own move-state columns get cleared on one. Created on
     first use by offleaseMoveHistory.service.js. */
  OFF_LEASE_MOVE_HISTORY: 'Off-Lease Move History',

  // Public API framework — hidden bookkeeping tabs
  API_KEYS: '__api_keys',
  API_USAGE: '__api_usage',
  API_ADMIN_AUDIT: '__api_admin_audit',
  API_IDEMPOTENCY: '__api_idempotency',

  // Employee auth logs
  AUTH_LOG: '__login_log',
  AUTH_SESSION_LOG: 'Login Time Log'
};

// External spreadsheets referenced by hardcoded ID (not the main GOOGLE_SHEET_ID).
// Preserved as literal constants exactly as the original Apps Script hardcodes them.
export const EXTERNAL_SPREADSHEETS = {
  SALE_EXEC: {
    ssId: '1E7mHI6jClULDbB7jPFs3jRzzbYpdwi9Z', // the leads-assigned workbook
    tab: 'Company Assigned To'
  },
  INVOICE_TEMPLATE: {
    ssId: '1SZQzdi8Fk2Yffp3WA7N14wMoqGTPPWaWtBm1tCx4aH0'
  },
  CONSOLIDATE: {
    ssId: '1_9Lsg4Arz-dFWflaIBKJq8LHWkextr0w3XLPGiP1Iic',
    tab: 'Consoldate Data'
  },
  FMS_AGREEMENT: {
    // Same workbook as CONSOLIDATE
    ssId: '1_9Lsg4Arz-dFWflaIBKJq8LHWkextr0w3XLPGiP1Iic',
    tab: 'STAGE5.1'
  },
  FMS_STAGE1: {
    tab: 'STAGE1'
  },
  // "Master Sheet" / "container_master_logs" — the off-lease approval sync
  // target (LMS.js _syncOffLeaseRowToMaster/updateOffLeaseData hardcode this
  // exact ID via SpreadsheetApp.openById(...), a workbook separate from
  // GOOGLE_SHEET_ID). Tab names reuse SHEETS.MASTER_SHEET / SHEETS.CONTAINER_MASTER_LOGS.
  MASTER_WORKBOOK: {
    ssId: '1qgAe0QOx93SRd8isBFCr5o1khnCBX0G2DM42nSuiRFo'
  }
};

export const CLIENT_MASTER_TAB = SHEETS.CLIENT_DB;
