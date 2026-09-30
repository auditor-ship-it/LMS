import { startRenewDocumentSso } from '../../services/sso.service.js';
import { RenewDocumentPage } from '../renewDocument/RenewDocumentPage.jsx';
import { SsoEmbedShell } from './SsoEmbedShell.jsx';

/**
 * Sales OS embed: https://lease.crystalgrp.xyz/sso/renew-document?
 * employeeCode=...(&token=...) — the real Renew & Document page (Update
 * Agreement — Save or Submit — and Send Back), reused verbatim. See
 * SsoLeaseExpiryPage.jsx for the shared reasoning (outside RequireAuth,
 * scoped by salePersonAccess.service.js's SALE_PERSON_BY_EMAIL, and every
 * action here calls the exact same backend endpoints the in-app page does).
 *
 * Submitting here STAGES the renewal for approval — see SsoApprovalPendingPage
 * for where that gets decided; Sales OS needs both embeds for the full flow.
 */
export function SsoRenewDocumentPage() {
  return (
    <SsoEmbedShell start={startRenewDocumentSso}>
      <RenewDocumentPage />
    </SsoEmbedShell>
  );
}
