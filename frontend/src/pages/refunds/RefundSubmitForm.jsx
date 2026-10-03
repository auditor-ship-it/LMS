import { useState } from 'react';
import { Button, FileUpload } from '../../components/ui/index.js';
import { apiErrorMessage } from '../../shared/auth/index.js';
import { uploadStageFile } from '../../services/upload.service.js';
import { submitRefund } from '../../services/refunds.service.js';
import styles from './RefundsPage.module.css';

const ACCEPT = '.pdf,.jpg,.jpeg,.png,.gif,.xls,.xlsx';

/* Ledger Head/Department are fixed, not user-chosen — explicit request
   2026-10-01: this form is Security Deposit refunds only, and "Operation"
   was Department's only real dropdown choice already. */
export const FIXED_LEDGER_HEAD = 'Security Deposit Refundable';
export const FIXED_DEPARTMENT = 'Operation';

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** `dateStr` + `days`, in <input type="date">'s "yyyy-MM-dd" shape — explicit
 *  request 2026-10-01 ("auto matically 7 days"). */
function addDays(dateStr, days) {
  if (!dateStr) return '';
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return '';
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* Explicit request 2026-10-01: Invoice Number/Date, Payment Type/Terms, User
   and Bill Received Date are no longer collected (SD refunds don't have a
   vendor invoice in the traditional sense) — the sheet still HAS these
   columns (REFUNDS_HEADERS unchanged, see refunds.service.js) so old rows
   keep their data and nothing shifts column-wise; this form just stops
   sending values for them. SD Amount to be Refunded/SD Calculation (the old
   numeric fields) are likewise superseded by the renamed Invoice
   Amount/Invoice(file) fields below. */
export function makeEmptyForm(containerNo = '') {
  return {
    containerNo,
    vendorName: '',
    invoiceAmount: '', amountToPay: '', paymentDueDate: addDays(todayStr(), 7),
    cancelledChequeFile: null, clientEmailConfirmationFile: null, clientLedgerFile: null,
    invoiceFile: null, piFile: null, attachmentsFile: null
  };
}

/**
 * The "Submit a Bill" SD-refund form — extracted from RefundsPage.jsx
 * 2026-10-01 (explicit request: "add the stage 6 SD refunds... same this
 * form and this backend logic") so Off-Lease Stage 6 can launch the exact
 * same form/submit path (same addRefundEntry call, same sheet, same
 * approval flow) in a modal, rather than a second, divergent copy of it.
 * `onSubmitted` fires after a successful save (caller decides what to do —
 * RefundsPage.jsx reloads its own list, Stage 6's modal closes).
 *
 * `lockedContainerNo` (explicit request 2026-10-01, same change that added
 * Container No as a required field): when opened from Off-Lease Stage 6, the
 * container is already known from context — pre-filled and not editable, so
 * the bill can't accidentally be raised against the wrong one. The standalone
 * SD Refunds page passes nothing, leaving it a normal free-text field.
 *
 * `lockedClientName`/`lockedOffLeaseId` (explicit request 2026-10-03, "save
 * this backend container no and Client name and offlease id"): same Stage 6
 * context, but these two have no reason to be user-visible fields — they
 * just ride along with the submit so the row is traceable. Blank when
 * submitted from the standalone SD Refunds page, which has no container
 * context to pull them from.
 */
export function RefundSubmitForm({ onSubmitted, lockedContainerNo, lockedClientName, lockedOffLeaseId }) {
  const [form, setForm] = useState(() => makeEmptyForm(lockedContainerNo || ''));
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [submitOk, setSubmitOk] = useState(false);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setSubmitError('');
    setSubmitOk(false);
    try {
      const [invoiceFileUrl, piFileUrl, attachmentsUrl, cancelledChequeUrl, clientEmailConfirmationUrl, clientLedgerUrl] = await Promise.all([
        form.invoiceFile ? uploadStageFile(form.invoiceFile) : '',
        form.piFile ? uploadStageFile(form.piFile) : '',
        form.attachmentsFile ? uploadStageFile(form.attachmentsFile) : '',
        form.cancelledChequeFile ? uploadStageFile(form.cancelledChequeFile) : '',
        form.clientEmailConfirmationFile ? uploadStageFile(form.clientEmailConfirmationFile) : '',
        form.clientLedgerFile ? uploadStageFile(form.clientLedgerFile) : ''
      ]);
      await submitRefund({
        containerNo: form.containerNo,
        clientName: lockedClientName || '',
        offLeaseId: lockedOffLeaseId || '',
        vendorName: form.vendorName,
        invoiceAmount: form.invoiceAmount,
        amountToPay: form.amountToPay,
        paymentDueDate: form.paymentDueDate,
        ledgerHead: FIXED_LEDGER_HEAD,
        department: FIXED_DEPARTMENT,
        invoiceFileUrl, piFileUrl, attachmentsUrl,
        cancelledChequeUrl, clientEmailConfirmationUrl, clientLedgerUrl
      });
      setForm(makeEmptyForm(lockedContainerNo || ''));
      setSubmitOk(true);
      await onSubmitted?.();
    } catch (e2) {
      setSubmitError(apiErrorMessage(e2));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className={styles.form}>
      <div className={styles.grid3}>
        <label className={styles.field}>
          <span className={styles.label}>Container No *</span>
          <input type="text" value={form.containerNo} onChange={set('containerNo')} required disabled={!!lockedContainerNo} />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Department</span>
          <input type="text" value={FIXED_DEPARTMENT} disabled />
        </label>
      </div>

      <div className={styles.grid3}>
        <label className={styles.field}>
          <span className={styles.label}>Vendor Name *</span>
          <input type="text" value={form.vendorName} onChange={set('vendorName')} required />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>SD Amount *</span>
          <input type="number" step="0.01" value={form.invoiceAmount} onChange={set('invoiceAmount')} onWheel={(e) => e.target.blur()} required />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>SD Amount to be Refunded *</span>
          <input type="number" step="0.01" value={form.amountToPay} onChange={set('amountToPay')} onWheel={(e) => e.target.blur()} required />
        </label>
      </div>

      <div className={styles.grid3}>
        <label className={styles.field}>
          <span className={styles.label}>Payment Due Date</span>
          <input type="date" value={form.paymentDueDate} onChange={set('paymentDueDate')} />
          <span className={styles.hint}>Auto-filled as 7 days after Bill Received Date — adjust if needed.</span>
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Ledger Head</span>
          <input type="text" value={FIXED_LEDGER_HEAD} disabled />
        </label>
      </div>

      <div className={styles.grid3}>
        <label className={styles.field}>
          <span className={styles.label}>Cancelled Cheque</span>
          <FileUpload
            label={form.cancelledChequeFile ? `Selected: ${form.cancelledChequeFile.fileName}` : 'Upload cancelled cheque'}
            accept={ACCEPT}
            onSelected={(file) => setForm((f) => ({ ...f, cancelledChequeFile: file }))}
          />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Client Email Confirmation</span>
          <FileUpload
            label={form.clientEmailConfirmationFile ? `Selected: ${form.clientEmailConfirmationFile.fileName}` : 'Upload email confirmation'}
            accept={ACCEPT}
            onSelected={(file) => setForm((f) => ({ ...f, clientEmailConfirmationFile: file }))}
          />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Client Ledger</span>
          <FileUpload
            label={form.clientLedgerFile ? `Selected: ${form.clientLedgerFile.fileName}` : 'Upload client ledger'}
            accept={ACCEPT}
            onSelected={(file) => setForm((f) => ({ ...f, clientLedgerFile: file }))}
          />
        </label>
      </div>

      <div className={styles.grid3}>
        <label className={styles.field}>
          <span className={styles.label}>SD Calculation</span>
          <FileUpload
            label={form.invoiceFile ? `Selected: ${form.invoiceFile.fileName}` : 'Choose SD calculation file'}
            accept={ACCEPT}
            onSelected={(file) => setForm((f) => ({ ...f, invoiceFile: file }))}
          />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Quarterly Ledger</span>
          <FileUpload
            label={form.piFile ? `Selected: ${form.piFile.fileName}` : 'Choose quarterly ledger file'}
            accept={ACCEPT}
            onSelected={(file) => setForm((f) => ({ ...f, piFile: file }))}
          />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>SD Amounts to be Refunded</span>
          <FileUpload
            label={form.attachmentsFile ? `Selected: ${form.attachmentsFile.fileName}` : 'Choose SD amounts to be refunded file'}
            accept={ACCEPT}
            onSelected={(file) => setForm((f) => ({ ...f, attachmentsFile: file }))}
          />
        </label>
      </div>

      {submitError && <p className={styles.error}>{submitError}</p>}
      {submitOk && <p className={styles.success}>Saved.</p>}

      <div className={styles.footer}>
        <Button type="submit" variant="primary" loading={submitting}>Submit</Button>
      </div>
    </form>
  );
}
