import { useState } from 'react';
import { Modal } from '../../components/ui/Modal.jsx';
import { Button, FileUpload } from '../../components/ui/index.js';
import { apiErrorMessage } from '../../shared/auth/index.js';
import { uploadStageFile } from '../../services/upload.service.js';
import { submitRefund } from '../../services/refunds.service.js';
import { FIXED_LEDGER_HEAD, FIXED_DEPARTMENT } from '../refunds/RefundSubmitForm.jsx';
import formStyles from '../refunds/RefundsPage.module.css';
import styles from './PipelineDashboard.module.css';

const ACCEPT = '.pdf,.jpg,.jpeg,.png,.gif,.xls,.xlsx';

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addDays(dateStr, days) {
  if (!dateStr) return '';
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return '';
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Same SD Refund submission as RefundSubmitForm (same sheet, same
 * addRefundEntry call, same approval flow) — but one form fill creates ONE
 * entry PER selected container, reusing the same vendor/amount/files across
 * all of them. Explicit request 2026-11-10 ("MULTIPLE SELCT KAR KE EK HI
 * FROM FIR KAR NA HAI... SAME CLIENT NAME BUT DIFFRENST CONTAINER NO MUJHE
 * SAME FROM BHARNA HAI"): several containers under the same client, same
 * refund bill, raised once instead of re-typing the identical form N times.
 * `entries`: the selected PipelineDashboard rows, each
 * `{ container, clientName, leaseId }`. Container/Lease ID are per-entry and
 * locked (shown as a read-only list) — everything else is one shared form.
 */
export function BulkRefundModal({ entries, onClose, onSubmitted }) {
  const [vendorName, setVendorName] = useState(entries[0]?.clientName || '');
  const [invoiceAmount, setInvoiceAmount] = useState('');
  const [amountToPay, setAmountToPay] = useState('');
  const [paymentDueDate, setPaymentDueDate] = useState(addDays(todayStr(), 7));
  const [cancelledChequeFile, setCancelledChequeFile] = useState(null);
  const [clientEmailConfirmationFile, setClientEmailConfirmationFile] = useState(null);
  const [clientLedgerFile, setClientLedgerFile] = useState(null);
  const [invoiceFile, setInvoiceFile] = useState(null);
  const [piFile, setPiFile] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    const missing = [];
    if (!vendorName.trim()) missing.push('Vendor Name');
    if (!invoiceAmount.trim()) missing.push('SD Amount');
    if (!amountToPay.trim()) missing.push('SD Amount to be Refunded');
    if (missing.length) {
      setSubmitError(`Please fill in: ${missing.join(', ')}.`);
      return;
    }

    setSubmitting(true);
    setSubmitError('');
    try {
      // Uploaded once — the same bill/documents apply to every selected container.
      const [invoiceFileUrl, piFileUrl, cancelledChequeUrl, clientEmailConfirmationUrl, clientLedgerUrl] = await Promise.all([
        invoiceFile ? uploadStageFile(invoiceFile) : '',
        piFile ? uploadStageFile(piFile) : '',
        cancelledChequeFile ? uploadStageFile(cancelledChequeFile) : '',
        clientEmailConfirmationFile ? uploadStageFile(clientEmailConfirmationFile) : '',
        clientLedgerFile ? uploadStageFile(clientLedgerFile) : ''
      ]);

      for (const entry of entries) {
        await submitRefund({
          containerNo: entry.container,
          clientName: entry.clientName || '',
          offLeaseId: entry.leaseId || '',
          vendorName,
          invoiceAmount,
          amountToPay,
          paymentDueDate,
          ledgerHead: FIXED_LEDGER_HEAD,
          department: FIXED_DEPARTMENT,
          invoiceFileUrl, piFileUrl,
          cancelledChequeUrl, clientEmailConfirmationUrl, clientLedgerUrl
        });
      }
      await onSubmitted?.();
      onClose();
    } catch (e2) {
      setSubmitError(apiErrorMessage(e2));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={`SD Refund — ${entries.length} containers`} width="640px">
      <form onSubmit={handleSubmit} className={formStyles.form}>
        <div className={styles.bulkEntryList}>
          <span className={formStyles.label}>Containers in this refund</span>
          <ul>
            {entries.map((en) => (
              <li key={`${en.leaseId || ''}-${en.container}`}>
                {en.container}{en.clientName ? ` — ${en.clientName}` : ''}
              </li>
            ))}
          </ul>
        </div>

        <div className={formStyles.grid3}>
          <label className={formStyles.field}>
            <span className={formStyles.label}>Vendor Name *</span>
            <input type="text" value={vendorName} onChange={(e) => setVendorName(e.target.value)} required />
          </label>
          <label className={formStyles.field}>
            <span className={formStyles.label}>SD Amount *</span>
            <input type="number" step="0.01" value={invoiceAmount} onChange={(e) => setInvoiceAmount(e.target.value)} onWheel={(e) => e.target.blur()} required />
          </label>
          <label className={formStyles.field}>
            <span className={formStyles.label}>SD Amount to be Refunded *</span>
            <input type="number" step="0.01" value={amountToPay} onChange={(e) => setAmountToPay(e.target.value)} onWheel={(e) => e.target.blur()} required />
          </label>
        </div>

        <div className={formStyles.grid3}>
          <label className={formStyles.field}>
            <span className={formStyles.label}>Payment Due Date</span>
            <input type="date" value={paymentDueDate} onChange={(e) => setPaymentDueDate(e.target.value)} />
            <span className={formStyles.hint}>Auto-filled as 7 days from today — adjust if needed.</span>
          </label>
          <label className={formStyles.field}>
            <span className={formStyles.label}>Ledger Head</span>
            <input type="text" value={FIXED_LEDGER_HEAD} disabled />
          </label>
        </div>

        <div className={formStyles.grid3}>
          <label className={formStyles.field}>
            <span className={formStyles.label}>Cancelled Cheque</span>
            <FileUpload
              label={cancelledChequeFile ? `Selected: ${cancelledChequeFile.fileName}` : 'Upload cancelled cheque'}
              accept={ACCEPT}
              onSelected={setCancelledChequeFile}
            />
          </label>
          <label className={formStyles.field}>
            <span className={formStyles.label}>Client Email Confirmation</span>
            <FileUpload
              label={clientEmailConfirmationFile ? `Selected: ${clientEmailConfirmationFile.fileName}` : 'Upload email confirmation'}
              accept={ACCEPT}
              onSelected={setClientEmailConfirmationFile}
            />
          </label>
          <label className={formStyles.field}>
            <span className={formStyles.label}>Client Ledger</span>
            <FileUpload
              label={clientLedgerFile ? `Selected: ${clientLedgerFile.fileName}` : 'Upload client ledger'}
              accept={ACCEPT}
              onSelected={setClientLedgerFile}
            />
          </label>
        </div>

        <div className={formStyles.grid3}>
          <label className={formStyles.field}>
            <span className={formStyles.label}>SD Calculation</span>
            <FileUpload
              label={invoiceFile ? `Selected: ${invoiceFile.fileName}` : 'Choose SD calculation file'}
              accept={ACCEPT}
              onSelected={setInvoiceFile}
            />
          </label>
          <label className={formStyles.field}>
            <span className={formStyles.label}>Quatre Ledger</span>
            <FileUpload
              label={piFile ? `Selected: ${piFile.fileName}` : 'Choose quatre ledger file'}
              accept={ACCEPT}
              onSelected={setPiFile}
            />
          </label>
        </div>

        {submitError && <p className={formStyles.error}>{submitError}</p>}

        <div className={formStyles.footer}>
          <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button type="submit" variant="primary" loading={submitting}>
            {submitting ? 'Submitting…' : `Submit for ${entries.length} containers`}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
