import { useEffect, useState } from 'react';
import { Modal, Button } from '../../components/ui/index.js';
import styles from './Modals.module.css';

/**
 * "Update Lease Period" — Renewed tab's row action. Only the new Valid-Upto
 * date is required; container/current-valid-upto/deployed-date are shown
 * read-only for context. Calls submitRenewal -> POST /verify/renew-with-agreement.
 *
 * Also doubles as the BULK version: pass `items` (an array, one entry per
 * selected container) instead of `item` and the same one date applies to
 * every container in the list — for a batch that was all renewed together
 * on the same date. `item` and `items` are mutually exclusive; whichever is
 * passed decides single vs bulk mode.
 */
export function RenewModal({ open, item, items, submitting, error, onClose, onSubmit }) {
  const [newDate, setNewDate] = useState('');
  const bulk = Array.isArray(items);

  useEffect(() => {
    if (open) setNewDate('');
  }, [open, item, items]);

  if (!bulk && !item) return null;
  if (bulk && !items.length) return null;

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!newDate) return;
    onSubmit({ newDate });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={bulk ? `Update Lease Period — ${items.length} containers` : 'Update Lease Period'}
      width="440px"
    >
      <form onSubmit={handleSubmit} className={styles.form}>
        {bulk ? (
          <div className={styles.field}>
            <span className={styles.label}>Containers ({items.length})</span>
            <div className={styles.bulkList}>{items.map((it) => it.containerNo).join(', ')}</div>
          </div>
        ) : (
          <>
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
          </>
        )}
        <label className={styles.field}>
          <span className={styles.label}>New Agreement Valid Upto *</span>
          <input type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} required autoFocus />
        </label>

        {error && <p className={styles.error}>{error}</p>}

        <div className={styles.footer}>
          <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button type="submit" variant="primary" loading={submitting}>
            {bulk ? `Update ${items.length}` : 'Update Period'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
