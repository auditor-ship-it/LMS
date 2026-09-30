import { startApprovalPendingSso } from '../../services/sso.service.js';
import { ApprovalPendingPage } from '../renewDocument/ApprovalPendingPage.jsx';
import { SsoEmbedShell } from './SsoEmbedShell.jsx';

/**
 * Sales OS embed: https://lease.crystalgrp.xyz/sso/approval-pending?
 * employeeCode=...(&token=...) — the real Approval Pending page, reused
 * verbatim. See SsoLeaseExpiryPage.jsx for the shared reasoning.
 *
 * IMPORTANT: Approve/Reject only appear for a login with the `renewApproval`
 * permission (Roles & Access) — the same one Pushpa Shetty has internally.
 * Anyone else SSO'd here sees the same table read-only, same as in-app. This
 * is meant for whichever admin does approvals from Sales OS, not every
 * salesperson.
 */
export function SsoApprovalPendingPage() {
  return (
    <SsoEmbedShell start={startApprovalPendingSso}>
      <ApprovalPendingPage />
    </SsoEmbedShell>
  );
}
