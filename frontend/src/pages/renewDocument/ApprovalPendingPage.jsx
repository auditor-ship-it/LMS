import { useMemo, useState } from 'react';
import { PageHeader, Card, Button, StatCard, DataGrid, renderCellValue } from '../../components/ui/index.js';
import { useAsync } from '../../hooks/useAsync.js';
import { usePermission } from '../../hooks/usePermission.js';
import { useAutoRefresh } from '../../hooks/useAutoRefresh.js';
import { invalidate } from '../../shared/dataBus.js';
import { apiErrorMessage } from '../../shared/auth/index.js';
import { fetchApprovalPendingList, submitApprovalDecision } from '../../services/renewDocument.service.js';
import { formatActionTimestamp } from '../../utils/formatDateTime.js';
import { isRateOrAmountHeader } from '../../utils/isRateOrAmountHeader.js';
import { ApprovalDecisionModal } from './ApprovalDecisionModal.jsx';
import { RenewRemarksModal } from './RenewRemarksModal.jsx';
import styles from './RenewDocumentPage.module.css';

// Same convention as RenewDocumentPage.jsx's own compact-table/detail split.
const DETAIL_ONLY_HEADERS = /^(location|size|type|city|po)$/i;

/**
 * Approval Pending — its own sidebar page, not a tab on Renew & Document
 * (explicit request 2026-09-29, reversing the tab this was first built as
 * earlier the same day). Backed by GET /expiry?filter=approval — renewals
 * Submit has staged and handed to Pushpa Shetty, not yet Approved/Rejected.
 * See expiry.service.js's decideRenewalApproval for what Approve/Reject
 * actually do; this page only calls it and shows the result.
 */
export function ApprovalPendingPage() {
  const { data, loading, error, reload } = useAsync(fetchApprovalPendingList, []);
  // Same channel Renew & Document's own Save/Submit invalidate — a
  // just-submitted renewal shows up here without a manual refresh.
  useAutoRefresh('deployed-sheet', reload);
  const { canAct } = usePermission();
  // Only Pushpa Shetty (or whoever Roles & Access grants this to) sees the
  // Approve/Reject buttons — everyone else still sees the table (view only),
  // so a submitter can track where their own request stands.
  const canApprove = canAct('renewApproval');

  const headers = data?.headers || [];
  const rows = data?.data || [];

  // System-wide: rate/amount/pricing columns are hidden from every data grid.
  const visibleColIdx = useMemo(
    () => headers.map((_, i) => i).filter((i) => !isRateOrAmountHeader(headers[i])),
    [headers]
  );
  const tableColIdx = useMemo(
    () => visibleColIdx.filter((i) => !DETAIL_ONLY_HEADERS.test(String(headers[i] || '').trim())),
    [visibleColIdx, headers]
  );
  const tableHeaders = tableColIdx.map((i) => headers[i]);

  const [decisionTarget, setDecisionTarget] = useState(null); // { containerNo, rowNum, decision }
  const [decisionBusy, setDecisionBusy] = useState(false);
  const [decisionError, setDecisionError] = useState('');

  // Row-detail + remarks modal — explicit request 2026-10-05 ("click the row
  // and open then remarks comment option"), widened 2026-10-07 ("click the
  // row open and show all data") to also show the full record, not just the
  // comment thread. { item, headers, colIdx } | null.
  const [remarksTarget, setRemarksTarget] = useState(null);

  const openDecision = (item, decision) => {
    setDecisionError('');
    setDecisionTarget({ containerNo: item.row?.[0], rowNum: item._rowNum, decision });
  };
  const handleDecisionSubmit = async (remarks) => {
    if (!decisionTarget) return;
    setDecisionBusy(true);
    setDecisionError('');
    try {
      const result = await submitApprovalDecision({
        containerNo: decisionTarget.containerNo, decision: decisionTarget.decision, remarks, rowNum: decisionTarget.rowNum
      });
      if (result === 'INVALID_STATE') setDecisionError('Already decided by someone else.');
      else {
        setDecisionTarget(null);
        await reload();
        invalidate('deployed-sheet');
      }
    } catch (e) {
      setDecisionError(apiErrorMessage(e));
    } finally {
      setDecisionBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Renew Approval Pending"
        subtitle="Renewals submitted for approval, awaiting Pushpa Shetty's decision"
        actions={<Button variant="secondary" size="sm" onClick={reload}>Refresh</Button>}
      />

      <div className={styles.kpiRow}>
        <StatCard
          icon="clock" label="Approval Pending" value={rows.length} tint="info"
          footnote={rows.length > 0 ? "Awaiting Pushpa's decision" : undefined}
        />
      </div>

      <Card>
        <DataGrid
          className={styles.vTable}
          headers={[...tableHeaders, 'Submitted Date', 'Submitted By', 'Draft Renewed Date', 'Draft Valid Till', 'Draft Signed Copy', 'Draft PO No', 'Draft PO Validity', 'Draft PO Value', 'Draft PO PDF', 'Draft Billing Cycle']}
          rows={rows}
          loading={loading}
          error={error}
          onRetry={reload}
          emptyMessage="No renewals awaiting approval"
          rowKey={(r) => r.row?.[0]}
          onRowClick={(item) => setRemarksTarget({ item, headers, colIdx: visibleColIdx })}
          renderRow={(values, item) => [
            ...tableColIdx.map((ci) => <td key={ci}>{renderCellValue(values[ci])}</td>),
            <td key="sd">{formatActionTimestamp(item.renewalSubmittedDate) || '—'}</td>,
            <td key="sb">{item.submittedBy || '—'}</td>,
            <td key="drd">{item.draftRenewedDate ? formatActionTimestamp(item.draftRenewedDate) : '—'}</td>,
            <td key="dvt">{item.draftValidTill ? formatActionTimestamp(item.draftValidTill) : '—'}</td>,
            // The actual uploaded document from Submit — explicit request 2026-10-05
            // ("renew pending approval not for pdf upload"): Pushpa had no way to open
            // what was submitted before deciding, only its metadata. draftSignedCopyUrl/
            // draftPoFileUrl already come off getExpiryDataByFilter('approval', ...),
            // just never rendered here.
            <td key="dsc">{renderCellValue(item.draftSignedCopyUrl)}</td>,
            <td key="dpo">{item.draftPoNo || '—'}</td>,
            <td key="dpoval">{item.draftPoValidity || '—'}</td>,
            <td key="dpoamt">{item.draftPoValue || '—'}</td>,
            <td key="dpopdf">{renderCellValue(item.draftPoFileUrl)}</td>,
            <td key="dbc">{item.draftBillingCycle || '—'}</td>
          ]}
          renderActions={(item) => (
            canApprove ? (
              <div className={styles.approvalActions}>
                <Button size="sm" variant="primary" onClick={() => openDecision(item, 'approved')}>Approve</Button>
                {/* Secondary, not danger — this sends the record back to Renew &
                    Document's Pending list for correction, it doesn't end the
                    renewal (same colour convention Off-Lease's own Send Back
                    uses). The decision value stays 'rejected' — see
                    ApprovalDecisionModal's own doc comment. */}
                <Button size="sm" variant="secondary" onClick={() => openDecision(item, 'rejected')}>Send Back</Button>
              </div>
            ) : <span className={styles.viewOnly}>View only</span>
          )}
        />
      </Card>

      <ApprovalDecisionModal
        open={!!decisionTarget}
        item={decisionTarget}
        decision={decisionTarget?.decision}
        submitting={decisionBusy}
        error={decisionError}
        onClose={() => setDecisionTarget(null)}
        onSubmit={handleDecisionSubmit}
      />

      <RenewRemarksModal
        item={remarksTarget}
        onClose={() => setRemarksTarget(null)}
        canApprove={canApprove}
        onDecided={async () => {
          setRemarksTarget(null);
          await reload();
          invalidate('deployed-sheet');
        }}
      />
    </>
  );
}
