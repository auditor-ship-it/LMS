import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth, setStoredToken, apiErrorMessage } from '../../shared/auth/index.js';
import { LoadingState, ErrorState } from '../../components/ui/index.js';
import { startLeaseExpirySso } from '../../services/sso.service.js';
import { LeaseExpiryPage } from '../leaseExpiry/LeaseExpiryPage.jsx';
import styles from './SsoLeaseExpiryPage.module.css';

/**
 * Sales OS's "Lease" section embed: https://lease.crystalgrp.xyz/sso/
 * lease-expiry?employeeCode=...(&token=...) — meant to be loaded in an
 * iframe from Sales OS's own KAM page, next to (not replacing) their
 * existing "Leads" section. Deliberately outside RequireAuth/AppShell, same
 * reasoning as pages/sso/SsoSalesOsPage.jsx — there is no session until this
 * page's own first call creates one by employeeCode alone.
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
  const [searchParams] = useSearchParams();
  const { reload } = useAuth();
  const [status, setStatus] = useState('authenticating'); // authenticating | ready | error
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await startLeaseExpirySso(searchParams);
        if (cancelled) return;
        setStoredToken(res.token);
        await reload();
        setStatus('ready');
      } catch (e) {
        if (cancelled) return;
        setError(apiErrorMessage(e));
        setStatus('error');
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (status === 'authenticating') return <LoadingState label="Signing you in…" />;
  if (status === 'error') return <div className={styles.wrap}><ErrorState message={error} /></div>;

  return (
    <div className={styles.wrap}>
      <LeaseExpiryPage />
    </div>
  );
}
