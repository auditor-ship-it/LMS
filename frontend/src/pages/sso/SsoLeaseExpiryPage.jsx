import { startLeaseExpirySso } from '../../services/sso.service.js';
import { LeaseExpiryPage } from '../leaseExpiry/LeaseExpiryPage.jsx';
import { SsoEmbedShell } from './SsoEmbedShell.jsx';

/**
 * Sales OS's "Lease" section embed: https://lease.crystalgrp.xyz/sso/
 * lease-expiry?employeeCode=...(&token=...) — meant to be loaded in an
 * iframe from Sales OS's own KAM page, next to (not replacing) their
 * existing "Leads" section. Deliberately outside RequireAuth/AppShell, same
 * reasoning as pages/sso/SsoSalesOsPage.jsx — there is no session until
 * SsoEmbedShell's first call creates one by employeeCode alone.
 *
 * Renders the REAL LeaseExpiryPage component verbatim (not a rebuilt copy):
 * same data, same Renew/Off-Lease/Remarks actions, same backend, same
 * Google Sheet writes — just without AppShell's sidebar/topbar, since this
 * is meant to sit inside Sales OS's own page chrome, not LMS's.
 *
 * SCOPING: LeaseExpiryPage's own data is restricted by
 * salePersonAccess.service.js's SALE_PERSON_BY_EMAIL map — a login NOT in
 * that map sees every company's data, the same unscoped view an internal
 * admin gets. Each Sales OS salesperson who should only see their own book
 * needs their login added there (Lease-side, ask an admin) before this is
 * safe to roll out broadly.
 */
export function SsoLeaseExpiryPage() {
  return (
    <SsoEmbedShell start={startLeaseExpirySso}>
      <LeaseExpiryPage />
    </SsoEmbedShell>
  );
}
