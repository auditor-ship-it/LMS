import { useState } from 'react';
import { PageHeader, Card, Button, DataGrid } from '../../components/ui/index.js';
import { useAsync } from '../../hooks/useAsync.js';
import { usePermission } from '../../hooks/usePermission.js';
import { apiErrorMessage } from '../../shared/auth/index.js';
import { fetchRefunds, submitRefundApprovalDecision } from '../../services/refunds.service.js';
import { RefundApprovalModal } from './RefundApprovalModal.jsx';
import styles from './RefundsPage.module.css';

/* Mirrors backend/src/services/refunds.service.js's own STAGES map exactly
   (label/permission/next) — same duplication RefundsPage.jsx and
   RefundApprovalModal.jsx already carry, not shared into one file, matching
   this codebase's convention of small per-page duplication over a premature
   shared module for a 3-entry map. */
const STAGES = {
  hod: { label: 'HOD', permission: 'refundsApprovalHod', next: 'ceo' },
  ceo: { label: 'CEO', permission: 'refundsApprovalCeo', next: 'accounts' },
  accounts: { label: 'Accounts', permission: 'refundsApprovalAccounts', next: null }
};

function Link({ url }) {
  if (!url) return <span>—</span>;
  return <a href={url} target="_blank" rel="noreferrer">View</a>;
}

/* Full bill data (explicit request 2026-09-30: "HOD show all data") — same
 * for every tab. Each tab (HOD/CEO/Accounts, added the same day: "tab HOD
 * CEO and Accounts tab wise pending") additionally shows whichever PRIOR
 * stages' Remarks/Timestamp/Approver are relevant: HOD's tab has none (it's
 * first), CEO's tab shows HOD's, Accounts' tab shows both HOD's and CEO's —
 * so a stage's own always-blank columns (nothing decided here yet) aren't
 * shown on its own tab. */
const BASE_HEADERS = [
  'Timestamp', 'Submitted By Email', 'User', 'Invoice Number', 'Invoice Date',
  'Bill Received By', 'Name of Vendor', 'Full Amount', 'Amount to Payment',
  'Payment Due Date', 'Payment Type', 'Payment Terms', 'Invoice with Supporting/Statement',
  'PI', 'Department', 'Ledger Head', 'SD Amount to be Refunded', 'SD Calculation',
  'Cancelled Cheque', 'Client Email Confirmation', 'Client Ledger', 'Attachments'
];
const HOD_AUDIT_HEADERS = ['HOD Remarks', 'HOD Timestamp', 'HOD Approver Email'];
const CEO_AUDIT_HEADERS = ['CEO Remarks', 'CEO Timestamp', 'CEO Approver Email'];

function tableHeadersForTab(tab) {
  return [
    ...BASE_HEADERS,
    ...(tab !== 'hod' ? HOD_AUDIT_HEADERS : []),
    ...(tab === 'accounts' ? CEO_AUDIT_HEADERS : [])
  ];
}

/**
 * "Refunds Approval" — explicit request 2026-09-30, its own sidebar page
 * rather than inline actions on the Refunds page (same "separate approval
 * page" pattern as Renew Approval Pending vs. Renew & Document). Shows only
 * entries currently sitting at a stage this caller can decide — HOD sees
 * their own HOD-pending queue, CEO theirs, Accounts theirs. Approval emails'
 * deep links (?rowNum=&stage=) land here too, opening a focused Review card
 * for that one entry instead of making the approver hunt for it below.
 */
export function RefundsApprovalPage() {
  const { canAct } = usePermission();
  const availableTabs = ['hod', 'ceo', 'accounts'].filter((s) => canAct(STAGES[s].permission));
  const canApprove = availableTabs.length > 0;

  const { data, loading, error, reload } = useAsync(() => (canApprove ? fetchRefunds() : Promise.resolve({ headers: [], data: [] })), [canApprove]);
  const rows = data?.data || [];
  const myPending = rows.filter((r) => STAGES[r.currentStage] && canAct(STAGES[r.currentStage].permission));

  const [activeTab, setActiveTab] = useState(null);
  // Falls back to the first tab this caller can act on whenever activeTab
  // hasn't been explicitly picked yet (or no longer applies) — computed
  // rather than set during render, so there's no render-time setState.
  const effectiveTab = availableTabs.includes(activeTab) ? activeTab : availableTabs[0];
  const tabPending = myPending.filter((r) => r.currentStage === effectiveTab);
  const headers = tableHeadersForTab(effectiveTab);

  const params = new URLSearchParams(window.location.search);
  const reviewRowNum = params.get('rowNum') ? Number(params.get('rowNum')) : null;
  const reviewStage = params.get('stage');
  const reviewRow = reviewRowNum ? rows.find((r) => r._rowNum === reviewRowNum) : null;
  const reviewStageCfg = reviewStage ? STAGES[reviewStage] : null;
  const reviewIsActionable = !!(reviewRow && reviewStageCfg && reviewRow.currentStage === reviewStage && canAct(reviewStageCfg.permission));

  const [decisionTarget, setDecisionTarget] = useState(null); // { rowNum, stage, decision, invoiceNumber, nextStage, isFinalStage }
  const [decisionBusy, setDecisionBusy] = useState(false);
  const [decisionError, setDecisionError] = useState('');

  const openDecision = (row, stage, decision) => {
    setDecisionError('');
    setDecisionTarget({
      rowNum: row._rowNum, stage, decision, invoiceNumber: row.invoiceNumber,
      nextStage: STAGES[stage].next, isFinalStage: !STAGES[stage].next
    });
  };
  const handleDecisionSubmit = async (remarks) => {
    if (!decisionTarget) return;
    setDecisionBusy(true);
    setDecisionError('');
    try {
      const result = await submitRefundApprovalDecision({
        rowNum: decisionTarget.rowNum, stage: decisionTarget.stage, decision: decisionTarget.decision, remarks
      });
      if (result === 'INVALID_STATE') setDecisionError('Already decided, or not this stage\'s turn — refresh and try again.');
      else {
        setDecisionTarget(null);
        await reload();
      }
    } catch (e) {
      setDecisionError(apiErrorMessage(e));
    } finally {
      setDecisionBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Refunds Approval" subtitle="HOD / CEO / Accounts approval queue" actions={<Button variant="secondary" size="sm" onClick={reload}>Refresh</Button>} />

      {!canApprove ? (
        <Card><div className={styles.viewOnly}>You don't have any Refunds approval permission. Ask an admin to grant it via Roles & Access.</div></Card>
      ) : (
        <>
          {reviewRowNum && (
            <div className={styles.section}>
              <Card title={`Review — Invoice ${reviewRow?.invoiceNumber || reviewRowNum}`}>
                {!reviewRow ? (
                  <p className={styles.hint}>Loading, or this entry no longer exists…</p>
                ) : !reviewStageCfg ? (
                  <p className={styles.error}>Unknown approval stage in this link.</p>
                ) : !reviewIsActionable ? (
                  <p className={styles.hint}>
                    {reviewRow.currentStage !== reviewStage
                      ? `This entry has moved on — it's no longer at the ${STAGES[reviewStage]?.label || reviewStage} stage.`
                      : `You don't have permission to decide the ${reviewStageCfg.label} stage.`}
                  </p>
                ) : (
                  <>
                    <div className={styles.grid3}>
                      <div className={styles.field}><span className={styles.label}>User</span><span>{reviewRow.user}</span></div>
                      <div className={styles.field}><span className={styles.label}>Vendor</span><span>{reviewRow.vendorName}</span></div>
                      <div className={styles.field}><span className={styles.label}>Invoice Number</span><span>{reviewRow.invoiceNumber}</span></div>
                      <div className={styles.field}><span className={styles.label}>Invoice Date</span><span>{reviewRow.invoiceDate || '—'}</span></div>
                      <div className={styles.field}><span className={styles.label}>Bill Received By</span><span>{reviewRow.billReceivedBy || '—'}</span></div>
                      <div className={styles.field}><span className={styles.label}>Full Amount</span><span>{reviewRow.invoiceAmount}</span></div>
                      <div className={styles.field}><span className={styles.label}>Amount to Payment</span><span>{reviewRow.amountToPay}</span></div>
                      <div className={styles.field}><span className={styles.label}>Payment Due Date</span><span>{reviewRow.paymentDueDate || '—'}</span></div>
                      <div className={styles.field}><span className={styles.label}>Payment Type</span><span>{reviewRow.paymentType || '—'}</span></div>
                      <div className={styles.field}><span className={styles.label}>Payment Terms</span><span>{reviewRow.paymentTerms || '—'}</span></div>
                      <div className={styles.field}><span className={styles.label}>Ledger Head</span><span>{reviewRow.ledgerHead || '—'}</span></div>
                      <div className={styles.field}><span className={styles.label}>Department</span><span>{reviewRow.department}</span></div>
                      <div className={styles.field}><span className={styles.label}>SD Amount to be Refunded</span><span>{reviewRow.sdAmountToBeRefunded || '—'}</span></div>
                      <div className={styles.field}><span className={styles.label}>SD Calculation</span><span>{reviewRow.sdCalculation || '—'}</span></div>
                      <div className={styles.field}><span className={styles.label}>Invoice File</span><Link url={reviewRow.invoiceFileUrl} /></div>
                      <div className={styles.field}><span className={styles.label}>PI</span><Link url={reviewRow.piFileUrl} /></div>
                      <div className={styles.field}><span className={styles.label}>Cancelled Cheque</span><Link url={reviewRow.cancelledChequeUrl} /></div>
                      <div className={styles.field}><span className={styles.label}>Client Email Confirmation</span><Link url={reviewRow.clientEmailConfirmationUrl} /></div>
                      <div className={styles.field}><span className={styles.label}>Client Ledger</span><Link url={reviewRow.clientLedgerUrl} /></div>
                      <div className={styles.field}><span className={styles.label}>Attachments</span><Link url={reviewRow.attachmentsUrl} /></div>
                      <div className={styles.field}><span className={styles.label}>Submitted By</span><span>{reviewRow.userEmail}</span></div>
                    </div>

                    {/* HOD's own decision — shown once CEO or Accounts is
                        reviewing, so they have the prior stage's context. */}
                    {reviewStage !== 'hod' && (
                      <div className={styles.grid3} style={{ marginTop: 14 }}>
                        <div className={styles.field}><span className={styles.label}>HOD Remarks</span><span>{reviewRow.hodRemarks || '—'}</span></div>
                        <div className={styles.field}><span className={styles.label}>HOD Timestamp</span><span>{reviewRow.hodDate || '—'}</span></div>
                        <div className={styles.field}><span className={styles.label}>HOD Approver Email</span><span>{reviewRow.hodApprover || '—'}</span></div>
                      </div>
                    )}
                    {/* CEO's own decision — shown once Accounts is reviewing. */}
                    {reviewStage === 'accounts' && (
                      <div className={styles.grid3} style={{ marginTop: 14 }}>
                        <div className={styles.field}><span className={styles.label}>CEO Remarks</span><span>{reviewRow.ceoRemarks || '—'}</span></div>
                        <div className={styles.field}><span className={styles.label}>CEO Timestamp</span><span>{reviewRow.ceoDate || '—'}</span></div>
                        <div className={styles.field}><span className={styles.label}>CEO Approver Email</span><span>{reviewRow.ceoApprover || '—'}</span></div>
                      </div>
                    )}

                    <div className={styles.footer} style={{ marginTop: 14 }}>
                      <Button variant="danger" onClick={() => openDecision(reviewRow, reviewStage, 'rejected')}>Reject</Button>
                      <Button variant="primary" onClick={() => openDecision(reviewRow, reviewStage, 'approved')}>Approve</Button>
                    </div>
                  </>
                )}
              </Card>
            </div>
          )}

          <div className={styles.tabRow}>
            {availableTabs.map((tab) => {
              const count = myPending.filter((r) => r.currentStage === tab).length;
              return (
                <button
                  key={tab}
                  type="button"
                  className={`${styles.tab} ${effectiveTab === tab ? styles.tabActive : ''}`}
                  onClick={() => setActiveTab(tab)}
                >
                  {STAGES[tab].label}
                  <span className={styles.tabCount}>({count})</span>
                </button>
              );
            })}
          </div>

          <div className={styles.section}>
            <Card title={`${STAGES[effectiveTab]?.label || ''} — Pending Your Approval`}>
              <DataGrid
                headers={headers}
                rows={tabPending}
                loading={loading}
                error={error}
                onRetry={reload}
                emptyMessage="Nothing waiting on your approval"
                rowKey={(r, i) => `${r.invoiceNumber}-${i}`}
                renderRow={(_values, r) => [
                  <td key="ts">{r.timestamp}</td>,
                  <td key="ue">{r.userEmail}</td>,
                  <td key="u">{r.user}</td>,
                  <td key="in">{r.invoiceNumber}</td>,
                  <td key="id">{r.invoiceDate}</td>,
                  <td key="br">{r.billReceivedBy}</td>,
                  <td key="vn">{r.vendorName}</td>,
                  <td key="ia">{r.invoiceAmount}</td>,
                  <td key="ap">{r.amountToPay}</td>,
                  <td key="pd">{r.paymentDueDate}</td>,
                  <td key="pt">{r.paymentType}</td>,
                  <td key="pte">{r.paymentTerms}</td>,
                  <td key="if"><Link url={r.invoiceFileUrl} /></td>,
                  <td key="pf"><Link url={r.piFileUrl} /></td>,
                  <td key="dp">{r.department}</td>,
                  <td key="lh">{r.ledgerHead}</td>,
                  <td key="sda">{r.sdAmountToBeRefunded}</td>,
                  <td key="sdc">{r.sdCalculation}</td>,
                  <td key="cc"><Link url={r.cancelledChequeUrl} /></td>,
                  <td key="ce"><Link url={r.clientEmailConfirmationUrl} /></td>,
                  <td key="cl"><Link url={r.clientLedgerUrl} /></td>,
                  <td key="at"><Link url={r.attachmentsUrl} /></td>,
                  ...(effectiveTab !== 'hod' ? [
                    <td key="hr">{r.hodRemarks || '—'}</td>,
                    <td key="hd">{r.hodDate || '—'}</td>,
                    <td key="ha">{r.hodApprover || '—'}</td>
                  ] : []),
                  ...(effectiveTab === 'accounts' ? [
                    <td key="cr">{r.ceoRemarks || '—'}</td>,
                    <td key="cd">{r.ceoDate || '—'}</td>,
                    <td key="ca">{r.ceoApprover || '—'}</td>
                  ] : [])
                ]}
                renderActions={(r) => (
                  <div className={styles.approvalActions}>
                    <Button size="sm" variant="primary" onClick={() => openDecision(r, r.currentStage, 'approved')}>Approve</Button>
                    <Button size="sm" variant="danger" onClick={() => openDecision(r, r.currentStage, 'rejected')}>Reject</Button>
                  </div>
                )}
              />
            </Card>
          </div>
        </>
      )}

      <RefundApprovalModal
        open={!!decisionTarget}
        target={decisionTarget}
        submitting={decisionBusy}
        error={decisionError}
        onClose={() => setDecisionTarget(null)}
        onSubmit={handleDecisionSubmit}
      />
    </>
  );
}
