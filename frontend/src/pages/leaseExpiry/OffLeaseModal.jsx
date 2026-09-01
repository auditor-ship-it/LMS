import { useEffect, useState } from 'react';
import { Modal, Button } from '../../components/ui/index.js';
import styles from './OffLeaseModal.module.css';

/**
 * Lease Expiry's "Off-Lease" confirmation — captures who requested/handled
 * it (Person Name, required) and an optional Remarks before the container
 * actually enters Off-Lease Stage 1. Same shape as Stage 1's own HoldModal
 * (frontend/src/pages/stages/HoldModal.jsx) and Stage 1A's RejectModal
 * (frontend/src/pages/offLease/RejectModal.jsx) — captured once, at
 * creation time, since Off-Lease Tracking has no other narrative field
 * until Stage 1's own form is filled in later.
 *
 * Doubles as the BULK version: pass `items` (array) instead of `item` and
 * the same Person Name/Remarks applies to every selected container — same
 * convention as RenewModal.jsx/RejectModal.jsx.
 */
export function OffLeaseModal({ open, item, items, submitting, error, onClose, onSubmit }) {
  const [personName, setPersonName] = useState('');
  const [remarks, setRemarks] = useState('');
  const bulk = Array.isArray(items);

  useEffect(() => {
    if (open) { setPersonName(''); setRemarks(''); }
  }, [open, item, items]);

  if (!bulk && !item) return null;
  if (bulk && !items.length) return null;

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!personName.trim()) return;
    onSubmit({ personName: personName.trim(), remarks: remarks.trim() });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={bulk ? `Off-Lease — ${items.length} containers` : 'Off-Lease Container'}
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
          <span className={styles.label}>Person Name *</span>
          <input
            type="text"
            value={personName}
            onChange={(e) => setPersonName(e.target.value)}
            placeholder="Who requested this off-lease?"
            required
            autoFocus
          />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Remarks / Comment</span>
          <textarea
            rows={3}
            value={remarks}
            onChange={(e) => setRemarks(e.target.value)}
            placeholder="Optional"
          />
        </label>

        {error && <p className={styles.error}>{error}</p>}

        <div className={styles.footer}>
          <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button type="submit" variant="primary" loading={submitting}>
            {bulk ? `Off-Lease ${items.length}` : 'Off-Lease'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
