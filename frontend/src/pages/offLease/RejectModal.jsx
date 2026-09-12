import { useEffect, useState } from 'react';
import { Modal, Button } from '../../components/ui/index.js';
import styles from './RejectModal.module.css';

/**
 * Stage 1.2 (Approval) "Reject" confirmation — captures a Remarks/Comment
 * before the rejection is actually saved, same shape as Stage 1's own
 * HoldModal (frontend/src/pages/stages/HoldModal.jsx). The remark is stored
 * in the SAME Intimation Approval Remarks column saveOffLeaseApprovalAction
 * already writes on Rejected — no new sheet column, unlike Hold.
 *
 * Doubles as the BULK version: pass `items` (array) instead of `item` and
 * the same remark applies to every selected container — same convention as
 * RenewModal.jsx.
 *
 * Generalized 2026-09-11 to also back the "Send Back" action (same capture-
 * a-remark-first shape, different wording/destination) — `titleWord`,
 * `placeholder`, `submitLabel` and `variant` override the Reject-specific
 * defaults below; the one existing Reject call site is unaffected since it
 * never passes them.
 */
export function RejectModal({
  open, item, items, submitting, error, onClose, onSubmit,
  titleWord = 'Reject', placeholder = 'Why is this being rejected? (optional)',
  submitLabel = 'Reject', variant = 'danger'
}) {
  const [remarks, setRemarks] = useState('');
  const bulk = Array.isArray(items);

  useEffect(() => {
    if (open) setRemarks('');
  }, [open, item, items]);

  if (!bulk && !item) return null;
  if (bulk && !items.length) return null;

  const handleSubmit = (e) => {
    e.preventDefault();
    onSubmit(remarks);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={bulk ? `${titleWord} — ${items.length} containers` : `${titleWord} Intimation`}
      width="440px"
    >
      <form onSubmit={handleSubmit} className={styles.form}>
        {bulk ? (
          <div className={styles.field}>
            <span className={styles.label}>Containers ({items.length})</span>
            <div className={styles.bulkList}>{items.map((it) => it.row?.[0]).join(', ')}</div>
          </div>
        ) : (
          <label className={styles.field}>
            <span className={styles.label}>Container</span>
            <input type="text" value={item.row?.[0] || ''} disabled />
          </label>
        )}
        <label className={styles.field}>
          <span className={styles.label}>Remarks / Comment</span>
          <textarea
            rows={3}
            value={remarks}
            onChange={(e) => setRemarks(e.target.value)}
            placeholder={placeholder}
            autoFocus
          />
        </label>

        {error && <p className={styles.error}>{error}</p>}

        <div className={styles.footer}>
          <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button type="submit" variant={variant} loading={submitting}>
            {bulk ? `${submitLabel} ${items.length}` : submitLabel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
