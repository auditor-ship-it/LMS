import { useEffect, useState } from 'react';
import { Card, Button, DataGrid } from '../../components/ui/index.js';
import { useAsync } from '../../hooks/useAsync.js';
import { usePolling } from '../../hooks/usePolling.js';
import { usePermission } from '../../hooks/usePermission.js';
import { apiErrorMessage } from '../../shared/auth/index.js';
import { fetchRefunds, submitRefundApprovalDecision } from '../../services/refunds.service.js';
import { RefundApprovalModal } from '../refunds/RefundApprovalModal.jsx';
import styles from '../refunds/RefundsPage.module.css';

/* Mirrors RefundsApprovalPage.jsx's own STAGES map — same deliberate
   duplication that file's own comment already explains (small per-page
   duplication over a premature shared module). This component only ever
   handles 'hod' or 'ceo', fixed by whichever Off-Lease tab (6A/6B) renders
   it — never a user-chosen tab the way RefundsApprovalPage.jsx's own
   HOD/CEO switcher is. */
const STAGE_META = {
  hod: { label: 'HOD', permission: 'refundsApprovalHod', next: 'ceo' },
  ceo: { label: 'CEO', permission: 'refundsApprovalCeo', next: null }
};

function Link({ url }) {
  if (!url) return <span>—</span>;
  return <a href={url} target="_blank" rel="noreferrer">View</a>;
}

const BASE_HEADERS = [
  'Timestamp', 'Submitted By Email', 'Name of Vendor', 'SD Amount', 'SD Amount to be Refunded',
  'Payment Due Date', 'SD Calculation',
  'Quarterly Ledger', 'Department', 'Ledger Head',
  'Cancelled Cheque', 'Client Email Confirmation', 'Client Ledger', 'SD Amounts to be Refunded'
];
const HOD_AUDIT_HEADERS = ['HOD Remarks', 'HOD Timestamp', 'HOD Approver Email'];

/**
 * Off-Lease's own "Stage 6A (HOD)" / "Stage 6B (CEO)" tabs — explicit
 * request 2026-10-05: HOD/CEO approval for SD Refunds (Stage 6) shown as
 * real Off-Lease tabs, same place as every other stage, not only reachable
 * via the separate "SD Refunds Approval" sidebar page (kept alongside this,
 * explicit request — same approvals, two doors to the same room).
 *
 * `tab` is fixed ('hod' or 'ceo') by which Off-Lease tab rendered this —
 * there is no internal tab-switcher here the way RefundsApprovalPage.jsx has
 * one, since Off-Lease's own tab strip already is that switcher.
 * `onCountChange` reports this tab's own pending count back up to
 * OffLeasePage.jsx so its tab badge shows the same number RefundsApprovalPage
 * would, without threading SD Refunds data through Off-Lease's own
 * OL_SHEET-based getOffLeaseStageCounts (a deliberately separate backend
 * system — see refunds.service.js's own header comment).
 */
export function SdRefundApprovalTab({ tab, onCountChange }) {
  const { canAct } = usePermission();
  const meta = STAGE_META[tab];
  const canApprove = canAct(meta.permission);

  const { data, loading, error, reload } = useAsync(
    () => (canApprove ? fetchRefunds() : Promise.resolve({ headers: [], data: [] })),
    [canApprove]
  );
  // Both tabs are mounted (just hidden) whenever they're visible, so their
  // badge counts need to stay fresh in the background — same pattern every
  // other Off-Lease tab uses (usePolling's own doc comment).
  usePolling(() => reload({ silent: true }));
  const rows = data?.data || [];
  const tabPending = rows.filter((r) => r.currentStage === tab);

  // Reports this tab's own pending count up to OffLeasePage.jsx's tab strip
  // — see this component's own doc comment for why that count doesn't come
  // from Off-Lease's own getOffLeaseStageCounts.
  useEffect(() => {
    onCountChange?.(tabPending.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabPending.length]);

  const headers = [
    ...BASE_HEADERS,
    ...(tab !== 'hod' ? HOD_AUDIT_HEADERS : []),
    'Container No', 'Client Name', 'Off-Lease ID'
  ];

  const [decisionTarget, setDecisionTarget] = useState(null);
  const [decisionBusy, setDecisionBusy] = useState(false);
  const [decisionError, setDecisionError] = useState('');

  const openDecision = (row, decision) => {
    setDecisionError('');
    setDecisionTarget({
      rowNum: row._rowNum, stage: tab, decision, invoiceNumber: row.invoiceNumber,
      nextStage: meta.next, isFinalStage: !meta.next
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

  if (!canApprove) {
    return (
      <Card>
        <div className={styles.viewOnly}>You don't have {meta.label} refunds approval permission. Ask an admin to grant it via Roles & Access.</div>
      </Card>
    );
  }

  return (
    <>
      <Card title={`${meta.label} — Pending Your Approval`} actions={<Button variant="secondary" size="sm" onClick={reload}>Refresh</Button>}>
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
            <td key="vn">{r.vendorName}</td>,
            <td key="ia">{r.invoiceAmount}</td>,
            <td key="ap">{r.amountToPay}</td>,
            <td key="pd">{r.paymentDueDate}</td>,
            <td key="if"><Link url={r.invoiceFileUrl} /></td>,
            <td key="pf"><Link url={r.piFileUrl} /></td>,
            <td key="dp">{r.department}</td>,
            <td key="lh">{r.ledgerHead}</td>,
            <td key="cc"><Link url={r.cancelledChequeUrl} /></td>,
            <td key="ce"><Link url={r.clientEmailConfirmationUrl} /></td>,
            <td key="cl"><Link url={r.clientLedgerUrl} /></td>,
            <td key="at"><Link url={r.attachmentsUrl} /></td>,
            ...(tab !== 'hod' ? [
              <td key="hr">{r.hodRemarks || '—'}</td>,
              <td key="hd">{r.hodDate || '—'}</td>,
              <td key="ha">{r.hodApprover || '—'}</td>
            ] : []),
            <td key="cn">{r.containerNo || '—'}</td>,
            <td key="clnm">{r.clientName || '—'}</td>,
            <td key="oid">{r.offLeaseId || '—'}</td>
          ]}
          renderActions={(r) => (
            <div className={styles.approvalActions}>
              <Button size="sm" variant="primary" onClick={() => openDecision(r, 'approved')}>Approve</Button>
              <Button size="sm" variant="danger" onClick={() => openDecision(r, 'rejected')}>Reject</Button>
            </div>
          )}
        />
      </Card>

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
