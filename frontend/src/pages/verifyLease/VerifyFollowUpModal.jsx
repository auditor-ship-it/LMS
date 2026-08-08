import { useEffect, useState } from 'react';
import { Modal, Button } from '../../components/ui/index.js';
import styles from './VerifyFollowUpModal.module.css';

const ISSUE_OPTIONS = [
  'Price / Rate Mismatch',
  'Document Missing',
  'Wrong Details',
  'PO Mismatch',
  'Client Query',
  'Other'
];

export function VerifyFollowUpModal({ open, submitting, saleExecutive, onClose, onSubmit }) {
  const [issue, setIssue] = useState('');
  const [remarks, setRemarks] = useState('');
  const [error, setError] = useState('');

  useEffect(() => { if (open) { setIssue(''); setRemarks(''); setError(''); } }, [open]);

  function handleSubmit() {
    if (!issue) { setError('Select an issue'); return; }
    const r = remarks.trim();
    if (!r) { setError('Enter remarks'); return; }
    onSubmit(r, issue);
  }

  return (
    <Modal open={open} onClose={onClose} title="Send Back / Follow-up" width="420px">
      <p className={styles.subtitle}>Record an issue and remarks for this record{saleExecutive ? ` — Sale Executive: ${saleExecutive}` : ''}</p>

      <label className={styles.label}>Issue</label>
      <select
        className={styles.input}
        style={{ marginBottom: 14 }}
        value={issue}
        onChange={(e) => { setIssue(e.target.value); setError(''); }}
      >
        <option value="">Select an issue…</option>
        {ISSUE_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>

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
