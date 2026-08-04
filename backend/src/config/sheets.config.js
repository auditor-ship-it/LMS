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
