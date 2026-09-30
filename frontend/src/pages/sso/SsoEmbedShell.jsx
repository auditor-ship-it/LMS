import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth, setStoredToken, apiErrorMessage } from '../../shared/auth/index.js';
import { LoadingState, ErrorState } from '../../components/ui/index.js';
import styles from './EmbedShell.module.css';

/**
 * Shared shell for every "embed the real LMS page in Sales OS" route
 * (SsoLeaseExpiryPage, SsoRenewDocumentPage, SsoApprovalPendingPage): runs
 * `start(searchParams)` once to SSO in by employeeCode alone (no password),
 * stores the resulting session token, then renders `children` — the actual
 * LMS page component, reused verbatim, not a rebuilt copy. Factored out once
 * three embeds needed the identical authenticating/error/ready dance.
 */
export function SsoEmbedShell({ start, children }) {
  const [searchParams] = useSearchParams();
  const { reload } = useAuth();
  const [status, setStatus] = useState('authenticating'); // authenticating | ready | error
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await start(searchParams);
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
    // Deliberately runs once — this is a landing page, not a re-fetchable view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (status === 'authenticating') return <LoadingState label="Signing you in…" />;
  if (status === 'error') return <div className={styles.wrap}><ErrorState message={error} /></div>;

  return <div className={styles.wrap}>{children}</div>;
}
