import { useState } from 'react';
import { PageHeader, Card, Button, FileUpload, DataGrid } from '../../components/ui/index.js';
import { useAsync } from '../../hooks/useAsync.js';
import { usePermission } from '../../hooks/usePermission.js';
import { apiErrorMessage } from '../../shared/auth/index.js';
import { uploadStageFile } from '../../services/upload.service.js';
import { fetchRefunds, submitRefund } from '../../services/refunds.service.js';
import styles from './RefundsPage.module.css';

function StageBadge({ status }) {
  const s = (status || '').trim();
  const cls = s === 'Approved' ? styles.stageApproved : s === 'Rejected' ? styles.stageRejected : s === 'Pending' ? styles.stagePending : styles.stageDone;
  return <span className={`${styles.stageBadge} ${cls}`}>{s || '—'}</span>;
}

const ACCEPT = '.pdf,.jpg,.jpeg,.png,.gif,.xls,.xlsx';

/* Ledger Head is fixed, not user-chosen — explicit request 2026-10-01: this
   form is Security Deposit refunds only now, so there's nothing to pick. */
const FIXED_LEDGER_HEAD = 'Security Deposit Refundable';

/* Explicit request 2026-10-01: Invoice Number/Date, Payment Type/Terms are no
   longer collected from this form (SD refunds don't have a vendor invoice in
   the traditional sense) — removed from EMPTY_FORM along with them. The sheet
   still HAS these columns (REFUNDS_HEADERS unchanged, see refunds.service.js)
   so old rows keep their data and nothing shifts column-wise; this form just
   stops sending values for them (addRefundEntry already treats a missing
   field as blank via safeStr). SD Amount to be Refunded/SD Calculation (the
   old numeric fields) are removed the same way — superseded by the renamed
   Invoice Amount/Invoice(file) fields below. */
const EMPTY_FORM = {
  user: '', billReceivedBy: '', vendorName: '',
  invoiceAmount: '', amountToPay: '', paymentDueDate: '',
  cancelledChequeFile: null, clientEmailConfirmationFile: null, clientLedgerFile: null,
  department: '', invoiceFile: null, piFile: null, attachmentsFile: null
};

/** Bill Received Date + 7 days, in <input type="date">'s "yyyy-MM-dd" shape —
 *  explicit request 2026-10-01 ("auto matically 7 days"): Payment Due Date no
 *  longer has Payment Terms to derive from (that field is gone from this
 *  form), so it's auto-filled from this fixed rule instead. Still a normal
 *  editable date input afterward, in case it needs correcting. */
function addDays(dateStr, days) {
  if (!dateStr) return '';
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return '';
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* Exact header sequence/names given 2026-09-30 for the base columns — matches
   the live sheet's own header row (refunds.service.js's REFUNDS_HEADERS)
   column-for-column, up through Ledger Head; SD/attachment/approval columns
   follow after, same order the backend appends them in. */
const TABLE_HEADERS = [
  'Timestamp', 'Submitted By Email', 'User', 'Invoice Number', 'Invoice Date',
  'Bill Received By', 'Name of Vendor', 'Full Amount', 'Amount to Payment',
  'Payment Due Date', 'Payment Type', 'Payment Terms', 'Invoice with Supporting/Statement',
  'PI', 'Department', 'Ledger Head', 'SD Amount to be Refunded', 'SD Calculation',
  'Cancelled Cheque', 'Client Email Confirmation', 'Client Ledger', 'Attachments',
  'HOD', 'CEO', 'Accounts'
];

function Link({ url }) {
  if (!url) return <span>—</span>;
  return <a href={url} target="_blank" rel="noreferrer">View</a>;
}

/**
 * "Refunds" (Off-Lease Bills) — explicit request 2026-09-30. A vendor-bill
 * submission form saving to the live "Offlease Bills " sheet tab, mirrored
 * into Mongo (see backend/src/services/refunds.service.js). Timestamp and
 * the submitting user's email are captured server-side; the "User" field
 * here is a separate free-text name (who the bill is being raised for/by).
 *
 * Gated entirely behind the 'refunds' permission — no dedicated sidebar
 * toggle exists yet (same "always visible in the menu, view/act gated on
 * the page itself" convention as Approval Pending), so a caller with no
 * grant sees this page but not the form or the list.
 */
export function RefundsPage() {
  const { canAct } = usePermission();
  const canSubmit = canAct('refunds');
  // Read access is broader than submit access — an HOD/CEO/Accounts approver
  // clicking their email's deep link may hold only their own stage
  // permission, not the base 'refunds' (submit) one. Matches the backend's
  // own _assertCanViewRefunds in refunds.service.js.
  const canView = canSubmit || canAct('refundsApprovalHod') || canAct('refundsApprovalCeo') || canAct('refundsApprovalAccounts');

  const { data, loading, error, reload } = useAsync(() => (canView ? fetchRefunds() : Promise.resolve({ headers: [], data: [] })), [canView]);
  const rows = data?.data || [];

  const [form, setForm] = useState(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [submitOk, setSubmitOk] = useState(false);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  /* Bill Received Date drives Payment Due Date's auto-fill (see addDays'
     own doc comment) — still lets the date be edited afterward, same as a
     normal field, this just seeds it instead of leaving it blank. */
  const setBillReceivedBy = (e) => {
    const billReceivedBy = e.target.value;
    setForm((f) => ({ ...f, billReceivedBy, paymentDueDate: addDays(billReceivedBy, 7) }));
  };

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
        user: form.user,
        billReceivedBy: form.billReceivedBy,
        vendorName: form.vendorName,
        invoiceAmount: form.invoiceAmount,
        amountToPay: form.amountToPay,
        paymentDueDate: form.paymentDueDate,
        ledgerHead: FIXED_LEDGER_HEAD,
        department: form.department,
        invoiceFileUrl, piFileUrl, attachmentsUrl,
        cancelledChequeUrl, clientEmailConfirmationUrl, clientLedgerUrl
      });
      setForm(EMPTY_FORM);
      setSubmitOk(true);
      await reload();
    } catch (e2) {
      setSubmitError(apiErrorMessage(e2));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <PageHeader title="Refunds" subtitle="Off-Lease vendor bill submission" actions={<Button variant="secondary" size="sm" onClick={reload}>Refresh</Button>} />

      {!canView ? (
        <Card><div className={styles.viewOnly}>You don't have access to Refunds. Ask an admin to grant it via Roles & Access.</div></Card>
      ) : (
        <>
          {canSubmit && (
          <Card title="Submit a Bill">
            <form onSubmit={handleSubmit} className={styles.form}>
              <div className={styles.grid3}>
                <label className={styles.field}>
                  <span className={styles.label}>User *</span>
                  <input type="text" value={form.user} onChange={set('user')} required />
                </label>
                <label className={styles.field}>
                  <span className={styles.label}>Bill Received Date</span>
                  <input type="date" value={form.billReceivedBy} onChange={setBillReceivedBy} />
                </label>
                <label className={styles.field}>
                  <span className={styles.label}>Department *</span>
                  <select value={form.department} onChange={set('department')} required>
                    <option value="">Select…</option>
                    <option value="Operation">Operation</option>
                  </select>
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
                  <span className={styles.label}>Amount to Pay *</span>
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
          </Card>
          )}

          <div className={styles.section}>
            <Card title="Submitted Bills">
              <DataGrid
                headers={TABLE_HEADERS}
                rows={rows}
                loading={loading}
                error={error}
                onRetry={reload}
                emptyMessage="No bills submitted yet"
                rowKey={(r, i) => `${r.invoiceNumber}-${i}`}
                renderRow={(_values, r) => [
                  <td key="ts">{r.timestamp}</td>,
                  <td key="ue">{r.userEmail}</td>,
                  <td key="u">{r.user}</td>,
                  <td key="in">{r.invoiceNumber}</td>,
                  <td key="id">{r.invoiceDate}</td>,
                  <td key="br">{r.billReceivedBy}</td>,
                  <td key="vn">{r.vendorName}</td>,
                  <td key="ia">{r.invoiceAmount}</td>,
                  <td key="ap">{r.amountToPay}</td>,
                  <td key="pd">{r.paymentDueDate}</td>,
                  <td key="pt">{r.paymentType}</td>,
                  <td key="pte">{r.paymentTerms}</td>,
                  <td key="if"><Link url={r.invoiceFileUrl} /></td>,
                  <td key="pf"><Link url={r.piFileUrl} /></td>,
                  <td key="dp">{r.department}</td>,
                  <td key="lh">{r.ledgerHead}</td>,
                  <td key="sda">{r.sdAmountToBeRefunded}</td>,
                  <td key="sdc">{r.sdCalculation}</td>,
                  <td key="cc"><Link url={r.cancelledChequeUrl} /></td>,
                  <td key="ce"><Link url={r.clientEmailConfirmationUrl} /></td>,
                  <td key="cl"><Link url={r.clientLedgerUrl} /></td>,
                  <td key="at"><Link url={r.attachmentsUrl} /></td>,
                  <td key="hod"><StageBadge status={r.hodStatus} /></td>,
                  <td key="ceo"><StageBadge status={r.ceoStatus} /></td>,
                  <td key="acc"><StageBadge status={r.accountsStatus} /></td>
                ]}
              />
            </Card>
          </div>
        </>
      )}
    </>
  );
}
