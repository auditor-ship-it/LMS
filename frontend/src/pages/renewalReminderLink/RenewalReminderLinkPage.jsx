import { startRenewalReminderLinkSso } from '../../services/renewalReminderLink.service.js';
import { LeaseExpiryPage } from '../leaseExpiry/LeaseExpiryPage.jsx';
import { SsoEmbedShell } from '../sso/SsoEmbedShell.jsx';

/**
 * No-login renewal reminder action (explicit request 2026-10-30, final
 * SSO-based redesign) — reached only via the signed ?token= link minted by
 * renewalReminderLink.service.js's mintRenewalReminderLink and emailed in
 * the renewal reminder digest. SSOs the clicker in as the container's
 * resolved KAM (a real, full-access login — explicitly confirmed trade-off,
 * see ssoIntoLeaseExpiry's own doc comment) and renders the REAL
 * LeaseExpiryPage, same component the Sales OS embed
 * (pages/sso/SsoLeaseExpiryPage.jsx) reuses verbatim — not a rebuilt copy.
 * LeaseExpiryPage reads `?container=` itself to auto-select the one row
 * this link was minted for.
 */
export function RenewalReminderLinkPage() {
  return (
    <SsoEmbedShell start={startRenewalReminderLinkSso}>
      <LeaseExpiryPage />
    </SsoEmbedShell>
  );
}
