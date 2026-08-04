import { useEffect, useState } from 'react';
import { Button } from '../../components/ui/index.js';
import styles from './VerifyApproveModal.module.css';

/**
 * Collects the two required fields (Billing Type, Invoice Type) plus the
 * conditional Link Container No. before calling approveVerify() — Verify
 * Lease only ever writes status 'Approved', there is no reject path here.
 * See verify.api.js's saveVerifyAction JSDoc for the exact field meanings.
 */
export function VerifyApproveModal({ open, container, submitting, serverError, onClose, onSubmit }) {
  const [billingType, setBillingType] = useState('');
  const [invoiceType, setInvoiceType] = useState('');
  const [linkContainer, setLinkContainer] = useState('');
  const [formError, setFormError] = useState('');

  useEffect(() => {
    if (open) {
      setBillingType('');
      setInvoiceType('');
      setLinkContainer('');
      setFormError('');
    }
  }, [open]);

  if (!open) return null;

  function handleSubmit() {
    if (!billingType) { setFormError('Select a billing type'); return; }
    if (!invoiceType) { setFormError('Select an invoice type'); return; }
    if (invoiceType === 'Link to Container' && !linkContainer.trim()) {
      setFormError('Enter the linked container number');
      return;
    }
    setFormError('');
    onSubmit({ billingType, invoiceType, linkContainer: linkContainer.trim() });
  }

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="Approve lease verification">
      <div className={styles.panel}>
        <h2 className={styles.title}>Approve Lease Verification</h2>
        <p className={styles.subtitle}>Select billing and invoice preferences</p>

        <label className={styles.label} htmlFor="verify-container">Container</label>
        <input id="verify-container" type="text" className={styles.input} value={container} disabled />

        <label className={styles.label} htmlFor="verify-billing-type">Billing Type *</label>
        <select
          id="verify-billing-type"
          className={styles.select}
          value={billingType}
          onChange={(e) => setBillingType(e.target.value)}
        >
          <option value="">Select</option>
          <option value="End">End</option>
          <option value="Advance">Advance</option>
        </select>

        <label className={styles.label} htmlFor="verify-invoice-type">Invoice Type *</label>
        <select
          id="verify-invoice-type"
          className={styles.select}
          value={invoiceType}
          onChange={(e) => setInvoiceType(e.target.value)}
        >
          <option value="">Select</option>
          <option value="Separate">Separate</option>
          <option value="Link to Container">Link to Container</option>
        </select>

        {invoiceType === 'Link to Container' && (
          <>
            <label className={styles.label} htmlFor="verify-link-container">Link Container No. *</label>
            <input
              id="verify-link-container"
              type="text"
              className={styles.input}
              placeholder="Enter container number"
              value={linkContainer}
              onChange={(e) => setLinkContainer(e.target.value)}
            />
          </>
        )}

        {(formError || serverError) && <p className={styles.error}>{formError || serverError}</p>}

        <div className={styles.actions}>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button variant="primary" onClick={handleSubmit} loading={submitting}>Approve</Button>
        </div>
      </div>
    </div>
  );
}
