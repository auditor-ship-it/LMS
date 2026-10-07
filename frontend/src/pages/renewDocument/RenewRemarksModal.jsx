import { useState } from 'react';
import { Modal, Button, renderCellValue } from '../../components/ui/index.js';
import { apiErrorMessage } from '../../shared/auth/index.js';
import { submitApprovalDecision } from '../../services/renewDocument.service.js';
import { formatActionTimestamp } from '../../utils/formatDateTime.js';
import styles from './RenewRemarksModal.module.css';

/* The submission/draft fields ApprovalPendingPage.jsx's own table appends
   after the raw sheet columns — not part of `headers`/`row` (they're
   computed per-item in expiry.service.js), so listed explicitly here, same
   order as that table reads left to right. */
const EXTRA_FIELDS = [
  ['Submitted Date', (it) => formatActionTimestamp(it.renewalSubmittedDate)],
  ['Submitted By', (it) => it.submittedBy],
  ['Draft Renewed Date', (it) => it.draftRenewedDate && formatActionTimestamp(it.draftRenewedDate)],
  ['Draft Valid Till', (it) => it.draftValidTill && formatActionTimestamp(it.draftValidTill)],
  ['Draft Signed Copy', (it) => it.draftSignedCopyUrl],
  ['Draft PO No', (it) => it.draftPoNo],
  ['Draft PO PDF', (it) => it.draftPoFileUrl],
  ['Draft Billing Cycle', (it) => it.draftBillingCycle]
];

/**
 * Renew Approval Pending's row detail + decision — explicit request
 * 2026-10-05 ("click the row and open then remarks comment option"), widened
 * 2026-10-07 ("click the row open and show all data") to show the full
 * record, then REWORKED the same day ("remove this and add approval reject
 * and remaks type option"): the open-ended comment thread (post/edit/delete,
 * kept indefinitely) is gone, replaced by a single inline decision — type a
 * remark, click Approve or Reject, it submits immediately right here, same
 * backend call (submitApprovalDecision) and same remark field the table's
 * own row buttons' ApprovalDecisionModal uses, just with no second popup.
 *
 * `target` is { item, headers, colIdx } (headers/colIdx = the page's own
 * visibleColIdx — every rate/amount-filtered column, which is MORE than the
 * compact table's own further-trimmed tableColIdx) — null closes the modal
 * (Modal itself unmounts its content then, so state resets for free on the
 * next open via the key prop below).
 *
 * `canApprove`/`onDecided` come from ApprovalPendingPage.jsx — the same
 * `canApprove` (renewApproval permission) gate the table's Approve/Reject
 * buttons use; onDecided reloads the list and closes this modal on success.
 */
export function RenewRemarksModal({ item: target, onClose, canApprove, onDecided }) {
  const containerNo = target?.item?.row?.[0];
  const rowNum = target?.item?._rowNum;
  return (
    <Modal open={!!target} onClose={onClose} title={target ? `${containerNo} — Details` : ''} width="640px">
      {target && (
        <ModalBody
          key={`${containerNo}::${rowNum}`}
          target={target} containerNo={containerNo} rowNum={rowNum}
          canApprove={canApprove} onDecided={onDecided}
        />
      )}
    </Modal>
  );
}

function ModalBody({ target, containerNo, rowNum, canApprove, onDecided }) {
  const { item, headers, colIdx } = target;

  return (
    <div className={styles.wrap}>
      <div className={styles.detail}>
        {colIdx.map((ci) => (
          <div className={styles.detailRow} key={ci}>
            <span className={styles.detailLabel}>{headers[ci]}</span>
            <span className={styles.detailValue}>{renderCellValue(item.row?.[ci])}</span>
          </div>
        ))}
      </div>
      {/* Explicit request 2026-10-07 ("this old data add the header renew
          update") — the fields above are the container's existing record;
          everything below is what THIS submission is asking to change it
          to, so they need their own heading rather than reading as one
          undivided block. */}
      <p className={styles.sectionTitle}>Renew Update</p>
      <div className={styles.detail}>
        {EXTRA_FIELDS.map(([label, get]) => {
          const val = get(item);
          return (
            <div className={styles.detailRow} key={label}>
              <span className={styles.detailLabel}>{label}</span>
              <span className={styles.detailValue}>{renderCellValue(val)}</span>
            </div>
          );
        })}
      </div>

      {canApprove ? (
        <DecisionSection containerNo={containerNo} rowNum={rowNum} onDecided={onDecided} />
      ) : (
        <p className={styles.meta}>View only — you do not have Renew Approval permission.</p>
      )}
    </div>
  );
}

function DecisionSection({ containerNo, rowNum, onDecided }) {
  const [remarks, setRemarks] = useState('');
  // 'approved' | 'rejected' while that decision's own request is in flight —
  // also disables the OTHER button, so one click can't fire both decisions.
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');

  const decide = async (decision) => {
    setError('');
    setBusy(decision);
    try {
      const result = await submitApprovalDecision({ containerNo, decision, remarks, rowNum });
      if (result === 'INVALID_STATE') setError('Already decided by someone else.');
      else onDecided();
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={styles.remarksSection}>
      <p className={styles.sectionTitle}>Decision</p>
      <label className={styles.field}>
        <span className={styles.detailLabel}>Remarks (required to reject)</span>
        <textarea
          className={styles.textarea}
          value={remarks}
          onChange={(e) => setRemarks(e.target.value)}
          rows={4}
          disabled={!!busy}
          placeholder="Add a remark…"
        />
      </label>
      {error && <p className={styles.error}>{error}</p>}
      <div className={styles.composerActions}>
        <Button size="sm" variant="primary" loading={busy === 'approved'} disabled={!!busy} onClick={() => decide('approved')}>Approve</Button>
        <Button size="sm" variant="danger" loading={busy === 'rejected'} disabled={!!busy} onClick={() => decide('rejected')}>Reject</Button>
      </div>
    </div>
  );
}
