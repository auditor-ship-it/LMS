import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageHeader, Card, Button, LoadingState, ErrorState } from '../../components/ui/index.js';
import { apiErrorMessage } from '../../shared/auth/index.js';
import { fetchRefundReviewEntry, submitRefundReviewDecision } from '../../services/refunds.service.js';
import refundsStyles from '../refunds/RefundsPage.module.css';
import wrapStyles from '../sso/EmbedShell.module.css';
import styles from './RefundReviewPage.module.css';

/* REWORKED 2026-10-07 ("Change Stage 6 Approval Flow"): HOD -> Accounts ->
   CEO, CEO conditional on the bill's own SD Amount to be Refunded — see
   refunds.service.js's STAGES/_isCeoRequired doc comments. */
const STAGE_LABELS = { hod: 'HOD', ceo: 'CEO', accounts: 'Accounts' };

/* Every supporting document this entry can carry, in the order they should
   read — explicit request 2026-10-05 ("better the UI, so reading and
   approval increases - time efficiency"): collapsed into a single row of
   link chips instead of 6 grid cells each needing a glance to see if they're
   blank. A document with no URL is skipped entirely, not shown as "—". */
const DOC_FIELDS = [
  ['cancelledChequeUrl', 'Cancelled Cheque'],
  ['clientEmailConfirmationUrl', 'Client Email Confirmation'],
  ['clientLedgerUrl', 'Client Ledger'],
  ['invoiceFileUrl', 'SD Calculation'],
  ['piFileUrl', 'Quarterly Ledger'],
  ['attachmentsUrl', 'SD Amounts to be Refunded']
];

/**
 * No-login Refund review — explicit request 2026-10-01: a link written
 * straight into the Offlease Bills sheet's HOD/CEO/Accounts "Review Link"
 * column (and emailed the same way) opens this page directly, no LMS session
 * needed. Standalone — no AppShell/sidebar, mounted outside <RequireAuth> in
 * App.jsx, same posture as the /sso/* embeds but without even the
 * employeeCode sign-in step those do: the ?token= in the URL IS the
 * credential, scoped to exactly this one row/stage by the backend
 * (refunds.service.js's _verifyRefundReviewToken).
 *
 * REDESIGNED 2026-10-05 (explicit request: "add remark option at approval
 * panel. also, better the UI, so reading and approval increases - time
 * efficiency") — Remarks is now an inline textarea on this same screen
 * (previously only reachable by opening RefundApprovalModal after clicking
 * Approve/Reject — a working but extra-click design, fine for the internal
 * table pages that still use that modal, but this page IS the single focused
 * screen an approver lands on from an email link, so folding remarks into it
 * directly removes a step). Approve/Reject now submit straight from this
 * page's own state; RefundApprovalModal is no longer used here (still used
 * by RefundsApprovalPage.jsx/SdRefundApprovalTab.jsx, which decide from a
 * multi-row table where a confirmation modal still earns its place).
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

  const [remarks, setRemarks] = useState('');
  const [busyDecision, setBusyDecision] = useState(null); // 'approved' | 'rejected' | null
  const [decisionError, setDecisionError] = useState('');
  const [done, setDone] = useState(null); // 'approved' | 'rejected'

  const submitDecision = async (decision) => {
    setBusyDecision(decision);
    setDecisionError('');
    try {
      const result = await submitRefundReviewDecision({ rowNum, stage, token, decision, remarks });
      if (result === 'INVALID_STATE') {
        setDecisionError('Already decided, or not this stage\'s turn — reload and check.');
      } else {
        setDone(decision);
      }
    } catch (e) {
      setDecisionError(apiErrorMessage(e));
    } finally {
      setBusyDecision(null);
    }
  };

  const stageLabel = STAGE_LABELS[stage] || stage;
  const docs = entry ? DOC_FIELDS.filter(([key]) => entry[key]) : [];

  return (
    <div className={wrapStyles.wrap}>
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
              {/* HERO — the identity of what's being decided, read in one
                  glance: which container, which client, which lease. */}
              <div className={styles.hero}>
                <div className={styles.heroMain}>
                  <span className={styles.heroContainer}>{entry.containerNo || '—'}</span>
                  <span className={styles.heroClient}>{entry.clientName || '—'}</span>
                </div>
                <span className={styles.heroLeaseId}>{entry.offLeaseId || '—'}</span>
              </div>

              {/* KEY FIGURES — the numbers the decision actually hinges on,
                  bold and separated from the rest of the metadata below. */}
              <div className={styles.figuresRow}>
                <div className={styles.figure}>
                  <span className={styles.figureLabel}>SD Amount</span>
                  <span className={styles.figureValue}>{entry.invoiceAmount || '—'}</span>
                </div>
                <div className={styles.figure}>
                  <span className={styles.figureLabel}>To Be Refunded</span>
                  <span className={styles.figureValue}>{entry.amountToPay || '—'}</span>
                </div>
                <div className={styles.figure}>
                  <span className={styles.figureLabel}>Payment Due</span>
                  <span className={styles.figureValue}>{entry.paymentDueDate || '—'}</span>
                </div>
              </div>

              {/* SECONDARY DETAILS — still relevant, but not decision-driving;
                  a smaller, denser grid than the figures above. */}
              <div className={refundsStyles.grid3}>
                <div className={refundsStyles.field}><span className={refundsStyles.label}>Vendor</span><span>{entry.vendorName}</span></div>
                <div className={refundsStyles.field}><span className={refundsStyles.label}>Ledger Head</span><span>{entry.ledgerHead || '—'}</span></div>
                <div className={refundsStyles.field}><span className={refundsStyles.label}>Department</span><span>{entry.department}</span></div>
                <div className={refundsStyles.field}><span className={refundsStyles.label}>Submitted By</span><span>{entry.userEmail}</span></div>
              </div>

              {/* DOCUMENTS — one row of chips, blank ones simply absent. */}
              <p className={styles.sectionLabel}>Documents</p>
              {docs.length ? (
                <div className={styles.docsRow}>
                  {docs.map(([key, label]) => (
                    <a key={key} className={styles.docChip} href={entry[key]} target="_blank" rel="noreferrer">{label}</a>
                  ))}
                </div>
              ) : (
                <p className={styles.noDocs}>No documents attached.</p>
              )}

              {/* PRIOR STAGE(S) — every stage before this one's own decision,
                  for context: Accounts sees HOD's, CEO sees both HOD's and
                  Accounts'. */}
              {stage !== 'hod' && (
                <>
                  <p className={styles.sectionLabel}>HOD Decision</p>
                  <div className={styles.priorStage}>
                    <div className={refundsStyles.grid3}>
                      <div className={refundsStyles.field}><span className={refundsStyles.label}>Remarks</span><span>{entry.hodRemarks || '—'}</span></div>
                      <div className={refundsStyles.field}><span className={refundsStyles.label}>Timestamp</span><span>{entry.hodDate || '—'}</span></div>
                      <div className={refundsStyles.field}><span className={refundsStyles.label}>Approver</span><span>{entry.hodApprover || '—'}</span></div>
                    </div>
                  </div>
                </>
              )}
              {stage === 'ceo' && (
                <>
                  <p className={styles.sectionLabel}>Accounts Decision</p>
                  <div className={styles.priorStage}>
                    <div className={refundsStyles.grid3}>
                      <div className={refundsStyles.field}><span className={refundsStyles.label}>Remarks</span><span>{entry.accountsRemarks || '—'}</span></div>
                      <div className={refundsStyles.field}><span className={refundsStyles.label}>Timestamp</span><span>{entry.accountsDate || '—'}</span></div>
                      <div className={refundsStyles.field}><span className={refundsStyles.label}>Approver</span><span>{entry.accountsApprover || '—'}</span></div>
                    </div>
                  </div>
                </>
              )}

              {/* REMARKS — inline, always visible; no modal click needed to
                  reach it. */}
              <label className={styles.remarksField}>
                <span className={refundsStyles.label}>Remarks (optional for Approve, recommended for Reject)</span>
                <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} rows={3} />
              </label>

              {decisionError && <p className={refundsStyles.error} style={{ marginTop: 10 }}>{decisionError}</p>}

              <div className={refundsStyles.footer} style={{ marginTop: 14 }}>
                <Button variant="danger" loading={busyDecision === 'rejected'} disabled={!!busyDecision} onClick={() => submitDecision('rejected')}>Reject</Button>
                <Button variant="primary" loading={busyDecision === 'approved'} disabled={!!busyDecision} onClick={() => submitDecision('approved')}>Approve</Button>
              </div>
            </>
          )}
        </Card>
      )}
    </div>
  );
}
