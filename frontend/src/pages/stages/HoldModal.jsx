import { useEffect, useState } from 'react';
import { Modal, Button } from '../../components/ui/index.js';
import styles from './HoldModal.module.css';

/**
 * Stage 1 (Intimation) "Hold" confirmation — an optional Remarks/Comment
 * field captured before the record is actually parked. Submits via
 * StagePageBase's handleHold, which calls submitHold(containerNo, remarks).
 */
export function HoldModal({ open, item, submitting, error, onClose, onSubmit }) {
  const [remarks, setRemarks] = useState('');

  useEffect(() => {
    if (open) setRemarks('');
  }, [open, item]);

  if (!item) return null;

  const handleSubmit = (e) => {
    e.preventDefault();
    onSubmit(remarks);
  };

  return (
    <Modal open={open} onClose={onClose} title="Hold Record" width="440px">
      <form onSubmit={handleSubmit} className={styles.form}>
        <label className={styles.field}>
          <span className={styles.label}>Container</span>
          <input type="text" value={item.row?.[0] || ''} disabled />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Remarks / Comment</span>
          <textarea
            rows={3}
            value={remarks}
            onChange={(e) => setRemarks(e.target.value)}
            placeholder="Why is this record on hold? (optional)"
            autoFocus
          />
        </label>

        {error && <p className={styles.error}>{error}</p>}

        <div className={styles.footer}>
          <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button type="submit" variant="primary" loading={submitting}>Move to Hold</Button>
        </div>
      </form>
    </Modal>
  );
}
