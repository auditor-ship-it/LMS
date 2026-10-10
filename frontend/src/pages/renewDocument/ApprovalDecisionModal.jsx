import { useEffect, useState } from 'react';
import { Modal, Button } from '../../components/ui/index.js';
import styles from './Modals.module.css';

/**
 * Pushpa's Approve/Send Back decision on a submitted renewal — explicit
 * request 2026-09-29, relabelled 2026-10-10 ("Reject" -> "Send Back", and
 * its remark made mandatory — this was always a send-back-for-correction,
 * not a terminal rejection: the record returns to Renew & Document's own
 * Pending list for the submitter to fix and resubmit, never ends the
 * renewal outright). `decision` ('approved' | 'rejected') is fixed by which
 * button on the Approval Pending row opened this (see RenewDocumentPage.jsx),
 * not chosen inside the modal itself — the two are different enough actions
 * (Approve silently applies the renewal, Send Back notifies the Sales Person
 * + Shivani Dhall) that combining them into one "decision" dropdown risked a
 * wrong click going unnoticed. The decision VALUE sent to the backend is
 * still 'rejected' (unchanged — see decideRenewalApproval), only the label
 * shown here changed.
 */
export function ApprovalDecisionModal({ open, item, decision, submitting, error, onClose, onSubmit }) {
  const [remarks, setRemarks] = useState('');
  const [validationError, setValidationError] = useState('');

  useEffect(() => {
    if (open) { setRemarks(''); setValidationError(''); }
  }, [open, item]);

  if (!item) return null;

  const isApprove = decision === 'approved';

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!isApprove && !remarks.trim()) {
      setValidationError('Add a remark saying why this is being sent back.');
      return;
    }
    setValidationError('');
    onSubmit(remarks);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isApprove ? `Approve Renewal — ${item.containerNo}` : `Send Back Renewal — ${item.containerNo}`}
      width="480px"
    >
      <form onSubmit={handleSubmit} className={styles.form}>
        <p className={styles.hint}>
          {isApprove
            ? 'This will apply the renewal — update the Agreement/PO and Valid Upto with what was submitted.'
            : 'This will NOT apply the renewal. The record goes back to Pending for the submitter to fix and resubmit; the Sales Person and Shivani Dhall are notified.'}
        </p>

        <label className={styles.field}>
          <span className={styles.label}>Remarks{isApprove ? ' (optional)' : ' — why is this being sent back? *'}</span>
          <textarea
            value={remarks}
            onChange={(e) => { setRemarks(e.target.value); if (validationError) setValidationError(''); }}
            rows={4}
          />
        </label>

        {(validationError || error) && <p className={styles.error}>{validationError || error}</p>}

        <div className={styles.footer}>
          <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button type="submit" variant={isApprove ? 'primary' : 'secondary'} loading={submitting}>
            {isApprove ? 'Approve' : 'Send Back'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
