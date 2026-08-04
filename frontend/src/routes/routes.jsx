import { lazy } from 'react';
import { ROUTES } from '../constants/routes.js';

const MyTaskPage = lazy(() => import('../pages/myTask/MyTaskPage.jsx').then((m) => ({ default: m.MyTaskPage })));
const VerifyLeasePage = lazy(() => import('../pages/verifyLease/VerifyLeasePage.jsx').then((m) => ({ default: m.VerifyLeasePage })));
const ApproveLeasePage = lazy(() => import('../pages/approveLease/ApproveLeasePage.jsx').then((m) => ({ default: m.ApproveLeasePage })));
const LeaseExpiryPage = lazy(() => import('../pages/leaseExpiry/LeaseExpiryPage.jsx').then((m) => ({ default: m.LeaseExpiryPage })));
const RenewDocumentPage = lazy(() => import('../pages/renewDocument/RenewDocumentPage.jsx').then((m) => ({ default: m.RenewDocumentPage })));
const OffLeasePage = lazy(() => import('../pages/offLease/OffLeasePage.jsx').then((m) => ({ default: m.OffLeasePage })));
const DeployedSummaryPage = lazy(() => import('../pages/deployedSummary/DeployedSummaryPage.jsx').then((m) => ({ default: m.DeployedSummaryPage })));
const RolesAccessPage = lazy(() => import('../pages/rolesAccess/RolesAccessPage.jsx').then((m) => ({ default: m.RolesAccessPage })));

const Stage1Page = lazy(() => import('../pages/stages/Stage1Page.jsx').then((m) => ({ default: m.Stage1Page })));
const Stage2Page = lazy(() => import('../pages/stages/Stage2Page.jsx').then((m) => ({ default: m.Stage2Page })));
const Stage3Page = lazy(() => import('../pages/stages/Stage3Page.jsx').then((m) => ({ default: m.Stage3Page })));
const Stage4Page = lazy(() => import('../pages/stages/Stage4Page.jsx').then((m) => ({ default: m.Stage4Page })));
const Stage5Page = lazy(() => import('../pages/stages/Stage5Page.jsx').then((m) => ({ default: m.Stage5Page })));
const Stage6Page = lazy(() => import('../pages/stages/Stage6Page.jsx').then((m) => ({ default: m.Stage6Page })));
const Stage7Page = lazy(() => import('../pages/stages/Stage7Page.jsx').then((m) => ({ default: m.Stage7Page })));
const Stage8Page = lazy(() => import('../pages/stages/Stage8Page.jsx').then((m) => ({ default: m.Stage8Page })));

/** Route config consumed by App.jsx — one entry per sidebar leaf, all lazy-loaded. */
export const APP_ROUTES = [
  { path: ROUTES.MY_TASK, element: MyTaskPage },
  { path: ROUTES.VERIFY_LEASE, element: VerifyLeasePage },
  { path: ROUTES.APPROVE_LEASE, element: ApproveLeasePage },
  { path: ROUTES.LEASE_EXPIRY, element: LeaseExpiryPage },
  { path: ROUTES.RENEW_DOCUMENT, element: RenewDocumentPage },
  { path: ROUTES.OFF_LEASE, element: OffLeasePage },
  { path: ROUTES.DEPLOYED_SUMMARY, element: DeployedSummaryPage },
  { path: ROUTES.ROLES_ACCESS, element: RolesAccessPage },
  { path: ROUTES.stage(1), element: Stage1Page },
  { path: ROUTES.stage(2), element: Stage2Page },
  { path: ROUTES.stage(3), element: Stage3Page },
  { path: ROUTES.stage(4), element: Stage4Page },
  { path: ROUTES.stage(5), element: Stage5Page },
  { path: ROUTES.stage(6), element: Stage6Page },
  { path: ROUTES.stage(7), element: Stage7Page },
  { path: ROUTES.stage(8), element: Stage8Page }
];
