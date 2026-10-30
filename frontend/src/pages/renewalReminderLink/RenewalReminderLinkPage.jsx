import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageHeader, Card, Button, StatusBadge, LoadingState, ErrorState } from '../../components/ui/index.js';
import { apiErrorMessage } from '../../shared/auth/index.js';
import { fetchRenewalReminderLinkTarget, submitRenewalReminderLinkConfirm } from '../../services/renewalReminderLink.service.js';
import wrapStyles from '../sso/EmbedShell.module.css';
import leaseStyles from '../leaseExpiry/LeaseExpiryPage.module.css';
import styles from './RenewalReminderLinkPage.module.css';

const BAND_LABEL = { overdue: 'Overdue', critical: 'Critical', warning: 'Warning', safe: 'Safe' };

function formatDays(daysLeft) {
  if (typeof daysLeft !== 'number') return '—';
  if (daysLeft < 0) return `${Math.abs(daysLeft)}d overdue`;
  if (daysLeft === 0) return 'Today';
  return `${daysLeft}d left`;
}
/** "YYYY-MM-DD" -> "DD-MM-YYYY" — item.agreementDate/poDate arrive as ISO;
 *  item.row's own date cells (Deployed Date) are already display-formatted,
 *  so this is only applied where needed below. */
function formatIsoDate(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-');
  return `${d}-${m}-${y}`;
}

/* Same 4-group layout as the real Lease Expiry detail panel
   (LeaseExpiryPage.jsx's FIELD_GROUPS/LeaseExpiryDetail) — reusing that
   page's own CSS classes (leaseStyles) rather than a hand-rolled copy, so
   this reads as the exact same card a logged-in user sees there. Fields
   are hardcoded here (not header-text-matched like the original) since
   getLinkTarget's shape is already fixed and known. */
function fieldGroups(target) {
  return [
    {
      key: 'identity', label: 'Identity', tone: 'blue',
      fields: [
        ['Container No', target.container], ['Order No', target.orderNo || '—'],
        ['Customer Name', target.clientName], ['Size', target.size || '—'],
        ['Type', target.type || '—'], ['Location', target.location || '—'], ['City', target.city || '—']
      ]
    },
    {
      key: 'dates', label: 'Dates & Validity', tone: 'amber',
      fields: [
        ['Deployed Date', target.deployedDate || '—'],
        ['Agreement Valid Upto', target.agreementDate ? formatIsoDate(target.agreementDate) : '—'],
        ['PO Validity', target.poDate ? formatIsoDate(target.poDate) : '—'],
        ['Billing Cycle', target.billingCycle || '—'],
        ['Days Left', formatDays(target.daysLeft)]
      ]
    },
    {
      key: 'documents', label: 'Documents', tone: 'violet',
      fields: [
        ['Agreement PDF', target.agreementUrl ? <a href={target.agreementUrl} target="_blank" rel="noreferrer">Open</a> : '—'],
        ['PO', target.poNo || '—'],
        ['PO PDF', target.poPdfUrl ? <a href={target.poPdfUrl} target="_blank" rel="noreferrer">Open</a> : '—']
      ]
    },
    {
      key: 'sales', label: 'Sales', tone: 'green',
      fields: [['Sale Person', target.salePerson || '—']]
    }
  ];
}

/**
 * No-login renewal reminder action — explicit request 2026-10-29/30. A
 * per-container link minted into the renewal reminder digest email
 * (renewalReminderLink.service.js's mintRenewalReminderLink) opens this
 * page directly, no LMS session needed. Standalone — mounted outside
 * <RequireAuth> in App.jsx, same posture as RefundReviewPage.jsx: the
 * ?token= in the URL IS the credential, scoped to exactly this one
 * container by the backend.
 *
 * REDESIGNED 2026-10-30 ("click the renew and offlease two button make one
 * button and this action click the then open this"): was a generic
 * "Confirm {action}" page reached via two separate per-action links. Now a
 * single link opens this richer detail view (same Identity/Dates &
 * Validity/Documents/Sales layout as the real Lease Expiry detail panel),
 * with Off-Lease and Renew offered as two buttons on this one page — see
 * renewalReminderLink.service.js's own doc comment for why "Renew" here
 * still isn't a direct Sales-CRM handoff (that needs a real logged-in
 * identity this no-login context doesn't have).
 *
 * Deliberately shows ONLY this one container's data — no navigation into
 * the rest of the app, no list of other containers (explicit requirement:
 * "never show unrelated clients' records or options"), and no Rate/amount
 * field (explicit request 2026-10-30, same reasoning as the Off-Lease
 * notification email it was removed from — this no-login page is an even
 * more exposed surface).
 */
export function RenewalReminderLinkPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');

  const [target, setTarget] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!token) {
      setError('This link is missing required information.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      setTarget(await fetchRenewalReminderLinkTarget(token));
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const [busyAction, setBusyAction] = useState(null); // 'renew' | 'offlease' | null
  const [confirmError, setConfirmError] = useState('');
  const [done, setDone] = useState(null); // { action, result }

  const confirm = async (action) => {
    setBusyAction(action);
    setConfirmError('');
    try {
      const result = await submitRenewalReminderLinkConfirm(token, action);
      setDone({ action, result });
    } catch (e) {
      setConfirmError(apiErrorMessage(e));
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div className={wrapStyles.wrap}>
      <PageHeader title="Renewal Reminder" />

      {loading && <LoadingState label="Loading…" />}
      {!loading && error && <ErrorState message={error} onRetry={load} />}

      {!loading && !error && target && (
        <Card>
          <div className={leaseStyles.detailHeader}>
            <h4 className={leaseStyles.detailTitle}>{target.container}</h4>
            <StatusBadge status={BAND_LABEL[target.band] || '—'} />
          </div>

          <div className={leaseStyles.groupRow}>
            {fieldGroups(target).map((g) => (
              <div key={g.key} className={`${leaseStyles.group} ${leaseStyles[`tone${g.tone[0].toUpperCase()}${g.tone.slice(1)}`]}`}>
                <div className={leaseStyles.groupLabel}>{g.label}</div>
                <div className={leaseStyles.detailGrid}>
                  {g.fields.reduce((rows, f, i) => {
                    if (i % 2 === 0) rows.push([f]); else rows[rows.length - 1].push(f);
                    return rows;
                  }, []).map((row, i) => (
                    <div key={i} className={leaseStyles.fieldRow}>
                      {row.map(([label, value]) => (
                        <div key={label} className={leaseStyles.detailField}>
                          <div className={leaseStyles.detailLabel}>{label}</div>
                          <div className={leaseStyles.detailValue}>{value}</div>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {done ? (
            <p className={styles.hint}>
              {done.action === 'renew'
                ? `Done — assigned to ${done.result.assignedTo}. You can close this page.`
                : 'Done — Off-Lease started and the CRM team has been notified. You can close this page.'}
            </p>
          ) : (
            <>
              {confirmError && <p className={styles.error}>{confirmError}</p>}
              <div className={styles.footer}>
                <Button variant="secondary" loading={busyAction === 'offlease'} disabled={!!busyAction} onClick={() => confirm('offlease')}>Off-Lease</Button>
                <Button variant="primary" loading={busyAction === 'renew'} disabled={!!busyAction} onClick={() => confirm('renew')}>Renew</Button>
              </div>
            </>
          )}
        </Card>
      )}
    </div>
  );
}
