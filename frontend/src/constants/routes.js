/** Route path constants — single source of truth for both the router and the sidebar nav config. */
export const ROUTES = {
  MY_TASK: '/my-task',
  VERIFY_LEASE: '/verify-lease',
  APPROVE_LEASE: '/approve-lease',
  LEASE_EXPIRY: '/lease-expiry',
  RENEW_DOCUMENT: '/renew-document',
  OFF_LEASE: '/off-lease',
  DEPLOYED_SUMMARY: '/deployed-summary',
  ROLES_ACCESS: '/roles-access',
  STAGES: '/stages',
  stage: (n) => `/stages/stage-${n}`
};
