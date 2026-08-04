/**
 * Static permission baseline — ported verbatim from LMS.js (ACTION_PERMISSIONS,
 * ALL_ACCESS_EMAILS, ROLES_ADMIN_EMAILS, PERMISSION_KEYS, SIDEBAR_KEYS).
 * The dynamic Roles & Access sheets (Team Accounts / Sidebar Access) sit
 * ADDITIVELY on top of this — see services/roles.service.js. Do not remove
 * emails from here as part of a "cleanup"; that changes production access.
 */

export const ACTION_PERMISSIONS = {
  verify: ['sc@crystalgroup.in', 'intern@crystalgroup.in', 'shivani.dhall@crystalgroup.in', 'pushpa.shetty@crystalgroup.in', 'swati.barot@crystalgroup.in', 'support@crystalgroup.in', 'crystaladmin@crystalgroup.in', 'pc@crystalgroup.in'],
  approve: ['pushpa.shetty@crystalgroup.in', 'intern@crystalgroup.in', 'shivani.dhall@crystalgroup.in', 'sc@crystalgroup.in', 'swati.barot@crystalgroup.in', 'support@crystalgroup.in', 'crystaladmin@crystalgroup.in', 'pc@crystalgroup.in'],
  expiry: ['pushpa.shetty@crystalgroup.in', 'sc@crystalgroup.in', 'intern@crystalgroup.in', 'shivani.dhall@crystalgroup.in', 'swati.barot@crystalgroup.in', 'crm@crystalgroup.in', 'support@crystalgroup.in', 'dmo@crystalgroup.in', 'crystaladmin@crystalgroup.in', 'pc@crystalgroup.in'],
  renew: ['pushpa.shetty@crystalgroup.in', 'sc@crystalgroup.in', 'intern@crystalgroup.in', 'shivani.dhall@crystalgroup.in', 'swati.barot@crystalgroup.in', 'crm@crystalgroup.in', 'support@crystalgroup.in', 'mansi.agarwal@crystalgroup.in', 'dmo@crystalgroup.in', 'ar@crystalgroup.in', 'crystaladmin@crystalgroup.in', 'pc@crystalgroup.in'],
  document: ['pushpa.shetty@crystalgroup.in', 'sc@crystalgroup.in', 'intern@crystalgroup.in', 'shivani.dhall@crystalgroup.in', 'swati.barot@crystalgroup.in', 'crm@crystalgroup.in', 'support@crystalgroup.in', 'mansi.agarwal@crystalgroup.in', 'dmo@crystalgroup.in', 'ar@crystalgroup.in', 'crystaladmin@crystalgroup.in', 'pc@crystalgroup.in'],
  offleaseapproval: ['pushpa.shetty@crystalgroup.in', 'intern@crystalgroup.in', 'shivani.dhall@crystalgroup.in', 'swati.barot@crystalgroup.in', 'crm@crystalgroup.in', 'support@crystalgroup.in', 'mansi.agarwal@crystalgroup.in', 'dmo@crystalgroup.in', 'ar@crystalgroup.in', 'crystaladmin@crystalgroup.in', 'pc@crystalgroup.in'],
  offlease1: ['pushpa.shetty@crystalgroup.in', 'sc@crystalgroup.in', 'intern@crystalgroup.in', 'shivani.dhall@crystalgroup.in', 'swati.barot@crystalgroup.in', 'crm@crystalgroup.in', 'support@crystalgroup.in', 'mansi.agarwal@crystalgroup.in', 'dmo@crystalgroup.in', 'ar@crystalgroup.in', 'crystaladmin@crystalgroup.in', 'kshirod.khatua@crystalgroup.in', 'pc@crystalgroup.in'],
  offlease2: ['pushpa.shetty@crystalgroup.in', 'sc@crystalgroup.in', 'intern@crystalgroup.in', 'shivani.dhall@crystalgroup.in', 'swati.barot@crystalgroup.in', 'crm@crystalgroup.in', 'support@crystalgroup.in', 'mansi.agarwal@crystalgroup.in', 'dmo@crystalgroup.in', 'ar@crystalgroup.in', 'crystaladmin@crystalgroup.in', 'kshirod.khatua@crystalgroup.in', 'pc@crystalgroup.in'],
  offlease3: ['pushpa.shetty@crystalgroup.in', 'sc@crystalgroup.in', 'intern@crystalgroup.in', 'shivani.dhall@crystalgroup.in', 'swati.barot@crystalgroup.in', 'crm@crystalgroup.in', 'support@crystalgroup.in', 'mansi.agarwal@crystalgroup.in', 'dmo@crystalgroup.in', 'ar@crystalgroup.in', 'crystaladmin@crystalgroup.in', 'kshirod.khatua@crystalgroup.in', 'pc@crystalgroup.in', 'service@crystalgroup.in'],
  offlease4: ['pushpa.shetty@crystalgroup.in', 'sc@crystalgroup.in', 'intern@crystalgroup.in', 'shivani.dhall@crystalgroup.in', 'swati.barot@crystalgroup.in', 'crm@crystalgroup.in', 'support@crystalgroup.in', 'mansi.agarwal@crystalgroup.in', 'dmo@crystalgroup.in', 'ar@crystalgroup.in', 'crystaladmin@crystalgroup.in', 'kshirod.khatua@crystalgroup.in', 'pc@crystalgroup.in'],
  offlease5: ['pushpa.shetty@crystalgroup.in', 'sc@crystalgroup.in', 'intern@crystalgroup.in', 'shivani.dhall@crystalgroup.in', 'swati.barot@crystalgroup.in', 'crm@crystalgroup.in', 'support@crystalgroup.in', 'mansi.agarwal@crystalgroup.in', 'dmo@crystalgroup.in', 'ar@crystalgroup.in', 'crystaladmin@crystalgroup.in', 'kshirod.khatua@crystalgroup.in', 'pc@crystalgroup.in'],
  offlease6: ['pushpa.shetty@crystalgroup.in', 'sc@crystalgroup.in', 'intern@crystalgroup.in', 'shivani.dhall@crystalgroup.in', 'swati.barot@crystalgroup.in', 'crm@crystalgroup.in', 'support@crystalgroup.in', 'mansi.agarwal@crystalgroup.in', 'dmo@crystalgroup.in', 'ar@crystalgroup.in', 'crystaladmin@crystalgroup.in', 'kshirod.khatua@crystalgroup.in', 'pc@crystalgroup.in'],
  offlease7: ['pushpa.shetty@crystalgroup.in', 'sc@crystalgroup.in', 'intern@crystalgroup.in', 'shivani.dhall@crystalgroup.in', 'swati.barot@crystalgroup.in', 'crm@crystalgroup.in', 'support@crystalgroup.in', 'mansi.agarwal@crystalgroup.in', 'dmo@crystalgroup.in', 'ar@crystalgroup.in', 'kshirod.khatua@crystalgroup.in', 'pc@crystalgroup.in'],
  offlease8: ['pushpa.shetty@crystalgroup.in', 'sc@crystalgroup.in', 'intern@crystalgroup.in', 'shivani.dhall@crystalgroup.in', 'swati.barot@crystalgroup.in', 'crm@crystalgroup.in', 'support@crystalgroup.in', 'mansi.agarwal@crystalgroup.in', 'dmo@crystalgroup.in', 'ar@crystalgroup.in', 'kshirod.khatua@crystalgroup.in', 'pc@crystalgroup.in'],
  billing: ['shivani.dhall@crystalgroup.in', 'intern@crystalgroup.in', 'pushpa.shetty@crystalgroup.in', 'swati.barot@crystalgroup.in', 'support@crystalgroup.in', 'mansi.agarwal@crystalgroup.in', 'dmo@crystalgroup.in', 'crystaladmin@crystalgroup.in', 'pc@crystalgroup.in'],
  receivables: ['ar@crystalgroup.in', 'intern@crystalgroup.in', 'pushpa.shetty@crystalgroup.in', 'shivani.dhall@crystalgroup.in', 'swati.barot@crystalgroup.in', 'support@crystalgroup.in', 'crystaladmin@crystalgroup.in', 'pc@crystalgroup.in'],
  'default': ['intern@crystalgroup.in', 'shivani.dhall@crystalgroup.in', 'ar@crystalgroup.in', 'swati.barot@crystalgroup.in', 'crm@crystalgroup.in', 'support@crystalgroup.in', 'pc@crystalgroup.in']
};

// All-access users: allowed to perform EVERY action above (all workflow points).
// Does NOT grant API Key / API Kit admin — that stays gated to API_SUPER_ADMIN only.
export const ALL_ACCESS_EMAILS = ['aa@crystalgroup.in'];

export const ROLES_ADMIN_EMAILS = ['dmo@crystalgroup.in', 'support@crystalgroup.in', 'mansi.agarwal@crystalgroup.in', 'aa@crystalgroup.in'];

export const PERMISSION_KEYS = [
  { key: 'verify', label: 'Verify Lease' },
  { key: 'approve', label: 'Approve Lease' },
  { key: 'expiry', label: 'Lease Expiry' },
  { key: 'renew', label: 'Renew (Renewed action)' },
  { key: 'document', label: 'Renew > Documents' },
  { key: 'offleaseapproval', label: 'Off-Lease Approval' },
  { key: 'offlease1', label: 'Off-Lease Stage 1: Intimation' },
  { key: 'offlease2', label: 'Off-Lease Stage 2: Lifting' },
  { key: 'offlease3', label: 'Off-Lease Stage 3: Inspection' },
  { key: 'offlease4', label: 'Off-Lease Stage 4: Quotation' },
  { key: 'offlease5', label: 'Off-Lease Stage 5: Billing' },
  { key: 'offlease6', label: 'Off-Lease Stage 6: Transport' },
  { key: 'offlease7', label: 'Off-Lease Stage 7: Get In' },
  { key: 'offlease8', label: 'Off-Lease Stage 8: FMS Closure' },
  { key: 'billing', label: 'Billing' },
  { key: 'receivables', label: 'Receivables' }
];

export const SIDEBAR_KEYS = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'myTask', label: 'My Task' },
  { key: 'verify', label: 'Verify Lease' },
  { key: 'approve', label: 'Approve Lease' },
  { key: 'expiry', label: 'Lease Expiry' },
  { key: 'billing', label: 'Billing Sales' },
  { key: 'pendingBilling', label: 'Pending Billing' },
  { key: 'receivables', label: 'Receivables' },
  { key: 'statement', label: 'Monthly Statement' },
  { key: 'outstanding', label: 'Outstanding View' },
  { key: 'deployedSummary', label: 'Deployed Summary' },
  { key: 'report', label: 'Report' },
  { key: 'billingApproval', label: 'Billing Approval' },
  { key: 'disputeApproval', label: 'Dispute Approval' },
  { key: 'approvalSummary', label: 'Approval Summary' }
];
