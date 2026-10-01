/** Route path constants — single source of truth for both the router and the sidebar nav config. */
export const ROUTES = {
  MY_TASK: '/my-task',
  VERIFY_LEASE: '/verify-lease',
  APPROVE_LEASE: '/approve-lease',
  LEASE_EXPIRY: '/lease-expiry',
  RENEW_DOCUMENT: '/renew-document',
  APPROVAL_PENDING: '/approval-pending',
  OFF_LEASE: '/off-lease',
  OFF_LEASE_EFFICIENCY: '/off-lease-efficiency',
  DEPLOYED_SUMMARY: '/deployed-summary',
  ROLES_ACCESS: '/roles-access',
  API_ACCESS: '/api-access',
  REPORTS: '/reports',
  REFUNDS: '/refunds',
  REFUNDS_APPROVAL: '/refunds-approval',
  STAGES: '/stages',
  stage: (n) => `/stages/stage-${n}`
};
