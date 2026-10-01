import { useEffect, useState } from 'react';
import { Modal, Button } from '../../components/ui/index.js';
import styles from './RefundsPage.module.css';

const STAGE_LABELS = { hod: 'HOD', ceo: 'CEO', accounts: 'Accounts' };

/**
 * HOD/CEO/Accounts Approve/Reject decision on a submitted refund bill —
 * explicit request 2026-09-30, same "decision fixed by which button opened
 * this" pattern as Renew & Document's ApprovalDecisionModal. `target` is
 * { rowNum, stage, decision, invoiceNumber } — stage and decision are both
 * fixed by the row/button that opened this, never chosen inside the modal.
 */
export function RefundApprovalModal({ open, target, submitting, error, onClose, onSubmit }) {
  const [remarks, setRemarks] = useState('');

  useEffect(() => {
    if (open) setRemarks('');
  }, [open, target]);

  if (!target) return null;

  const isApprove = target.decision === 'approved';
  const stageLabel = STAGE_LABELS[target.stage] || target.stage;

  const handleSubmit = (e) => {
    e.preventDefault();
    onSubmit(remarks);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`${isApprove ? 'Approve' : 'Reject'} (${stageLabel}) — ${target.invoiceNumber}`}
      width="480px"
    >
      <form onSubmit={handleSubmit} className={styles.form}>
        <p className={styles.hint}>
          {isApprove
            ? target.isFinalStage
              ? 'This is the final stage — approving completes the refund workflow.'
              : `Approving moves this on to the next stage (${STAGE_LABELS[target.nextStage] || target.nextStage}).`
            : 'This will stop the refund workflow here. The submitter is notified with your remarks.'}
        </p>

        <label className={styles.field}>
          <span className={styles.label}>Remarks{isApprove ? ' (optional)' : ' — why is this being rejected?'}</span>
          <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} rows={4} />
        </label>

        {error && <p className={styles.error}>{error}</p>}

        <div className={styles.footer}>
          <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button type="submit" variant={isApprove ? 'primary' : 'danger'} loading={submitting}>
            {isApprove ? 'Approve' : 'Reject'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
