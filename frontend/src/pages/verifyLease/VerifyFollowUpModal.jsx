import { useEffect, useState } from 'react';
import { Modal, Button } from '../../components/ui/index.js';
import styles from './VerifyFollowUpModal.module.css';

export function VerifyFollowUpModal({ open, submitting, onClose, onSubmit }) {
  const [remarks, setRemarks] = useState('');
  const [error, setError] = useState('');

  useEffect(() => { if (open) { setRemarks(''); setError(''); } }, [open]);

  function handleSubmit() {
    const r = remarks.trim();
    if (!r) { setError('Enter remarks'); return; }
    onSubmit(r);
  }

  return (
    <Modal open={open} onClose={onClose} title="Add Follow-up" width="420px">
      <p className={styles.subtitle}>Record a follow-up note for this record</p>
      <label className={styles.label}>Remarks</label>
      <input
        type="text"
        className={styles.input}
        autoFocus
        placeholder="Enter remarks"
        value={remarks}
        onChange={(e) => { setRemarks(e.target.value); setError(''); }}
        onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); }}
      />
      {error && <p className={styles.error}>{error}</p>}
      <div className={styles.footer}>
        <Button variant="secondary" onClick={onClose} disabled={submitting}>Cancel</Button>
        <Button variant="primary" onClick={handleSubmit} loading={submitting}>Save</Button>
      </div>
    </Modal>
  );
}
