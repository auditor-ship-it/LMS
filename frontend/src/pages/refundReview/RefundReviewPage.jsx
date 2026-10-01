import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageHeader, Card, Button, LoadingState, ErrorState } from '../../components/ui/index.js';
import { apiErrorMessage } from '../../shared/auth/index.js';
import { fetchRefundReviewEntry, submitRefundReviewDecision } from '../../services/refunds.service.js';
import { RefundApprovalModal } from '../refunds/RefundApprovalModal.jsx';
import refundsStyles from '../refunds/RefundsPage.module.css';
import styles from '../sso/EmbedShell.module.css';

const STAGE_LABELS = { hod: 'HOD', ceo: 'CEO', accounts: 'Accounts' };
const STAGE_NEXT = { hod: 'ceo', ceo: 'accounts', accounts: null };

function Link({ url }) {
  if (!url) return <span>—</span>;
  return <a href={url} target="_blank" rel="noreferrer">View</a>;
}

/**
 * No-login Refund review — explicit request 2026-10-01: a link written
 * straight into the Offlease Bills sheet's HOD/CEO/Accounts "Review Link"
 * column (and emailed the same way) opens this page directly, no LMS session
 * needed. Standalone — no AppShell/sidebar, mounted outside <RequireAuth> in
 * App.jsx, same posture as the /sso/* embeds but without even the
 * employeeCode sign-in step those do: the ?token= in the URL IS the
 * credential, scoped to exactly this one row/stage by the backend
 * (refunds.service.js's _verifyRefundReviewToken).
 */
export function RefundReviewPage() {
  const [searchParams] = useSearchParams();
  const rowNum = Number(searchParams.get('rowNum'));
  const stage = searchParams.get('stage');
  const token = searchParams.get('token');

  const [entry, setEntry] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!rowNum || !stage || !token) {
      setError('This link is missing required information.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await fetchRefundReviewEntry({ rowNum, stage, token });
      setEntry(res.entry);
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowNum, stage, token]);

  useEffect(() => { load(); }, [load]);

  const [decisionTarget, setDecisionTarget] = useState(null);
  const [decisionBusy, setDecisionBusy] = useState(false);
  const [decisionError, setDecisionError] = useState('');
  const [done, setDone] = useState(null); // 'approved' | 'rejected'

  const openDecision = (decision) => {
    setDecisionError('');
    setDecisionTarget({
      rowNum, stage, decision, invoiceNumber: entry?.invoiceNumber,
      nextStage: STAGE_NEXT[stage], isFinalStage: !STAGE_NEXT[stage]
    });
  };

  const handleDecisionSubmit = async (remarks) => {
    if (!decisionTarget) return;
    setDecisionBusy(true);
    setDecisionError('');
    try {
      const result = await submitRefundReviewDecision({
        rowNum, stage, token, decision: decisionTarget.decision, remarks
      });
      if (result === 'INVALID_STATE') {
        setDecisionError('Already decided, or not this stage\'s turn — reload and check.');
      } else {
        setDecisionTarget(null);
        setDone(decisionTarget.decision);
      }
    } catch (e) {
      setDecisionError(apiErrorMessage(e));
    } finally {
      setDecisionBusy(false);
    }
  };

  const stageLabel = STAGE_LABELS[stage] || stage;

  return (
    <div className={styles.wrap}>
      <PageHeader title="Refund Approval Review" subtitle={stage ? `${stageLabel} stage` : undefined} />

      {loading && <LoadingState label="Loading…" />}
      {!loading && error && <ErrorState message={error} onRetry={load} />}

      {!loading && !error && entry && (
        <Card title={`Invoice ${entry.invoiceNumber || rowNum}`}>
          {entry.currentStage !== stage ? (
            <p className={refundsStyles.hint}>
              This entry has moved on — it&apos;s no longer at the {stageLabel} stage.
            </p>
          ) : done ? (
            <p className={refundsStyles.hint}>
              You {done === 'approved' ? 'approved' : 'rejected'} this entry. You can close this page.
            </p>
          ) : (
            <>
              <div className={refundsStyles.grid3}>
                <div className={refundsStyles.field}><span className={refundsStyles.label}>User</span><span>{entry.user}</span></div>
                <div className={refundsStyles.field}><span className={refundsStyles.label}>Vendor</span><span>{entry.vendorName}</span></div>
                <div className={refundsStyles.field}><span className={refundsStyles.label}>Invoice Number</span><span>{entry.invoiceNumber}</span></div>
                <div className={refundsStyles.field}><span className={refundsStyles.label}>Invoice Date</span><span>{entry.invoiceDate || '—'}</span></div>
                <div className={refundsStyles.field}><span className={refundsStyles.label}>Bill Received By</span><span>{entry.billReceivedBy || '—'}</span></div>
                <div className={refundsStyles.field}><span className={refundsStyles.label}>SD Amount</span><span>{entry.invoiceAmount}</span></div>
                <div className={refundsStyles.field}><span className={refundsStyles.label}>SD Amount to be Refunded</span><span>{entry.amountToPay}</span></div>
                <div className={refundsStyles.field}><span className={refundsStyles.label}>Payment Due Date</span><span>{entry.paymentDueDate || '—'}</span></div>
                <div className={refundsStyles.field}><span className={refundsStyles.label}>Payment Type</span><span>{entry.paymentType || '—'}</span></div>
                <div className={refundsStyles.field}><span className={refundsStyles.label}>Payment Terms</span><span>{entry.paymentTerms || '—'}</span></div>
                <div className={refundsStyles.field}><span className={refundsStyles.label}>Ledger Head</span><span>{entry.ledgerHead || '—'}</span></div>
                <div className={refundsStyles.field}><span className={refundsStyles.label}>Department</span><span>{entry.department}</span></div>
                <div className={refundsStyles.field}><span className={refundsStyles.label}>SD Amount to be Refunded</span><span>{entry.sdAmountToBeRefunded || '—'}</span></div>
                <div className={refundsStyles.field}><span className={refundsStyles.label}>SD Calculation</span><span>{entry.sdCalculation || '—'}</span></div>
                <div className={refundsStyles.field}><span className={refundsStyles.label}>SD Calculation</span><Link url={entry.invoiceFileUrl} /></div>
                <div className={refundsStyles.field}><span className={refundsStyles.label}>Quarterly Ledger</span><Link url={entry.piFileUrl} /></div>
                <div className={refundsStyles.field}><span className={refundsStyles.label}>Cancelled Cheque</span><Link url={entry.cancelledChequeUrl} /></div>
                <div className={refundsStyles.field}><span className={refundsStyles.label}>Client Email Confirmation</span><Link url={entry.clientEmailConfirmationUrl} /></div>
                <div className={refundsStyles.field}><span className={refundsStyles.label}>Client Ledger</span><Link url={entry.clientLedgerUrl} /></div>
                <div className={refundsStyles.field}><span className={refundsStyles.label}>SD Amounts to be Refunded</span><Link url={entry.attachmentsUrl} /></div>
                <div className={refundsStyles.field}><span className={refundsStyles.label}>Submitted By</span><span>{entry.userEmail}</span></div>
              </div>

              {stage !== 'hod' && (
                <div className={refundsStyles.grid3} style={{ marginTop: 14 }}>
                  <div className={refundsStyles.field}><span className={refundsStyles.label}>HOD Remarks</span><span>{entry.hodRemarks || '—'}</span></div>
                  <div className={refundsStyles.field}><span className={refundsStyles.label}>HOD Timestamp</span><span>{entry.hodDate || '—'}</span></div>
                  <div className={refundsStyles.field}><span className={refundsStyles.label}>HOD Approver Email</span><span>{entry.hodApprover || '—'}</span></div>
                </div>
              )}
              {stage === 'accounts' && (
                <div className={refundsStyles.grid3} style={{ marginTop: 14 }}>
                  <div className={refundsStyles.field}><span className={refundsStyles.label}>CEO Remarks</span><span>{entry.ceoRemarks || '—'}</span></div>
                  <div className={refundsStyles.field}><span className={refundsStyles.label}>CEO Timestamp</span><span>{entry.ceoDate || '—'}</span></div>
                  <div className={refundsStyles.field}><span className={refundsStyles.label}>CEO Approver Email</span><span>{entry.ceoApprover || '—'}</span></div>
                </div>
              )}

              <div className={refundsStyles.footer} style={{ marginTop: 14 }}>
                <Button variant="danger" onClick={() => openDecision('rejected')}>Reject</Button>
                <Button variant="primary" onClick={() => openDecision('approved')}>Approve</Button>
              </div>
            </>
          )}
        </Card>
      )}

      <RefundApprovalModal
        open={!!decisionTarget}
        target={decisionTarget}
        submitting={decisionBusy}
        error={decisionError}
        onClose={() => setDecisionTarget(null)}
        onSubmit={handleDecisionSubmit}
      />
    </div>
  );
}
