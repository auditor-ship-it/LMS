import { useEffect, useState } from 'react';
import { Modal, Button } from '../../components/ui/index.js';
import styles from './Modals.module.css';

/**
 * Pushpa's Approve/Reject decision on a submitted renewal — explicit request
 * 2026-09-29. `decision` ('approved' | 'rejected') is fixed by which button
 * on the Approval Pending row opened this (see RenewDocumentPage.jsx), not
 * chosen inside the modal itself — the two are different enough actions
 * (Approve silently applies the renewal, Reject notifies the Sales Person +
 * Shivani Dhall) that combining them into one "decision" dropdown risked a
 * wrong click going unnoticed. Remarks are optional for either.
 */
export function ApprovalDecisionModal({ open, item, decision, submitting, error, onClose, onSubmit }) {
  const [remarks, setRemarks] = useState('');

  useEffect(() => {
    if (open) setRemarks('');
  }, [open, item]);

  if (!item) return null;

  const isApprove = decision === 'approved';

  const handleSubmit = (e) => {
    e.preventDefault();
    onSubmit(remarks);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isApprove ? `Approve Renewal — ${item.containerNo}` : `Reject Renewal — ${item.containerNo}`}
      width="480px"
    >
      <form onSubmit={handleSubmit} className={styles.form}>
        <p className={styles.hint}>
          {isApprove
            ? 'This will apply the renewal — update the Agreement/PO and Valid Upto with what was submitted.'
            : 'This will NOT apply the renewal. The record goes back to Pending for the submitter to fix and resubmit; the Sales Person and Shivani Dhall are notified.'}
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
