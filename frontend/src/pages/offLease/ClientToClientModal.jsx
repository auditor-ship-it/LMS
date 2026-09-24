import { useEffect, useState } from 'react';
import { Modal, Button } from '../../components/ui/index.js';
import styles from './RejectModal.module.css';

/**
 * Stage 1A's "Client to Client" decision — a 4th outcome alongside Approve/
 * Send Back/Reject (RejectModal.jsx), explicit request 2026-09-23: the
 * container is going straight to a different client instead of physically
 * returning, so it captures who that client is (required) plus an optional
 * remark, same capture-first shape as Reject/Send Back. Reuses RejectModal's
 * own CSS module — same form layout, one extra field.
 *
 * Single-item only (no bulk variant) — unlike Approve/Reject, there is no
 * bulk "Client to Client" button anywhere in this app; a New Client Name
 * genuinely differs per container, so there is nothing sensible for a bulk
 * action to apply to every selected row at once.
 */
export function ClientToClientModal({ open, item, submitting, error, onClose, onSubmit }) {
  const [clientName, setClientName] = useState('');
  const [remarks, setRemarks] = useState('');
  const [validationError, setValidationError] = useState('');

  useEffect(() => {
    if (open) { setClientName(''); setRemarks(''); setValidationError(''); }
  }, [open, item]);

  if (!item) return null;

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!clientName.trim()) { setValidationError('Client Name is required'); return; }
    setValidationError('');
    onSubmit(clientName.trim(), remarks);
  };

  return (
    <Modal open={open} onClose={onClose} title="Client to Client — Intimation" width="440px">
      <form onSubmit={handleSubmit} className={styles.form}>
        <label className={styles.field}>
          <span className={styles.label}>Container</span>
          <input type="text" value={item.row?.[0] || ''} disabled />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>New Client Name *</span>
          <input
            type="text"
            value={clientName}
            onChange={(e) => setClientName(e.target.value)}
            placeholder="Who is this container going to?"
            autoFocus
          />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Remarks / Comment</span>
          <textarea
            rows={3}
            value={remarks}
            onChange={(e) => setRemarks(e.target.value)}
            placeholder="Any remarks for this transfer? (optional)"
          />
        </label>

        {(validationError || error) && <p className={styles.error}>{validationError || error}</p>}

        <div className={styles.footer}>
          <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button type="submit" variant="primary" loading={submitting}>Confirm</Button>
        </div>
      </form>
    </Modal>
  );
}
