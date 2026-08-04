import { useEffect, useState } from 'react';
import { Modal, Button } from '../../components/ui/index.js';
import styles from './Modals.module.css';

/**
 * "Update Lease Period" — Renewed tab's row action. Only the new Valid-Upto
 * date is required; container/current-valid-upto/deployed-date are shown
 * read-only for context. Calls submitRenewal -> POST /verify/renew-with-agreement.
 */
export function RenewModal({ open, item, submitting, error, onClose, onSubmit }) {
  const [newDate, setNewDate] = useState('');

  useEffect(() => {
    if (open) setNewDate('');
  }, [open, item]);

  if (!item) return null;

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!newDate) return;
    onSubmit({ newDate });
  };

  return (
    <Modal open={open} onClose={onClose} title="Update Lease Period" width="440px">
      <form onSubmit={handleSubmit} className={styles.form}>
        <label className={styles.field}>
          <span className={styles.label}>Container</span>
          <input type="text" value={item.containerNo || ''} disabled />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Current Valid Upto</span>
          <input type="text" value={item.currentValidUpto || '—'} disabled />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Deployed Date</span>
          <input type="text" value={item.deployedDate || '—'} disabled />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>New Agreement Valid Upto *</span>
          <input type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} required autoFocus />
        </label>

        {error && <p className={styles.error}>{error}</p>}

        <div className={styles.footer}>
          <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button type="submit" variant="primary" loading={submitting}>Update Period</Button>
        </div>
      </form>
    </Modal>
  );
}
