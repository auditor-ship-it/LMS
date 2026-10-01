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

/* Department, same treatment — explicit request 2026-10-01 ("department auto
   fetching operation only"): "Operation" was the dropdown's only real choice
   already, so it's auto-filled instead of making the submitter pick it. */
const FIXED_DEPARTMENT = 'Operation';

/* Explicit request 2026-10-01: Invoice Number/Date, Payment Type/Terms, User
   and Bill Received Date are no longer collected from this form (SD refunds
   don't have a vendor invoice in the traditional sense) — removed from
   EMPTY_FORM along with them. The sheet still HAS these columns
   (REFUNDS_HEADERS unchanged, see refunds.service.js) so old rows keep their
   data and nothing shifts column-wise; this form just stops sending values
   for them (addRefundEntry already treats a missing field as blank via
   safeStr, and no longer requires User/Invoice Number either). SD Amount to
   be Refunded/SD Calculation (the old numeric fields) are removed the same
   way — superseded by the renamed Invoice Amount/Invoice(file) fields below. */
function makeEmptyForm() {
  return {
    vendorName: '',
    invoiceAmount: '', amountToPay: '', paymentDueDate: addDays(todayStr(), 7),
    cancelledChequeFile: null, clientEmailConfirmationFile: null, clientLedgerFile: null,
    invoiceFile: null, piFile: null, attachmentsFile: null
  };
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** `dateStr` + `days`, in <input type="date">'s "yyyy-MM-dd" shape —
 *  explicit request 2026-10-01 ("auto matically 7 days"): Payment Due Date no
 *  longer has Payment Terms (or, since Bill Received Date was also hidden
 *  from the form, a received date) to derive from, so it's auto-filled from
 *  today + 7 at the moment the form is opened instead. Still a normal
 *  editable date input afterward, in case it needs correcting. */
function addDays(dateStr, days) {
  if (!dateStr) return '';
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return '';
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* Exact header sequence given 2026-09-30, column-for-column matching the
   live sheet's own header row (refunds.service.js's REFUNDS_HEADERS) — each
   position's LABEL is kept in sync with the submission form's own field
   labels below, even where the two no longer say the same thing as the raw
   sheet header (e.g. col 7 is still "Full Amount" in the sheet, but the form
   calls it "SD Amount" — explicit request 2026-10-01: "table header name
   hasn't changed"). Columns 16/17 ("SD Amount to be Refunded"/"SD
   Calculation") are the OLD numeric fields removed from the form the same
   day — left as-is here since they were never renamed, only retired; any
   label collision with columns 8/12 below (now renamed to the same words)
   reflects that these are now two different sheet columns sharing a label,
   not a bug to silently hide. */
/* User/Invoice Number/Invoice Date/Bill Received By dropped from this list
   entirely (not just renamed) — explicit request 2026-10-01 ("not show
   frontend"): these are the same fields removed from the submission form
   earlier today, so every row is permanently blank for them going forward;
   showing empty columns forever is just clutter. Old rows' data in those
   sheet columns is untouched, just no longer displayed here.
   Payment Type/Payment Terms (also removed from the form) and the OLD
   retired "SD Amount to be Refunded"/"SD Calculation" numeric columns
   (superseded by the renamed Amount to Pay/Invoice-file fields, which keep
   their columns below) dropped the same way, same day ("this hidden the
   table frontend"). */
const TABLE_HEADERS = [
  'Timestamp', 'Submitted By Email', 'Name of Vendor', 'SD Amount', 'SD Amount to be Refunded',
  'Payment Due Date', 'SD Calculation',
  'Quarterly Ledger', 'Department', 'Ledger Head',
  'Cancelled Cheque', 'Client Email Confirmation', 'Client Ledger', 'SD Amounts to be Refunded',
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

  const [form, setForm] = useState(makeEmptyForm);
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
        vendorName: form.vendorName,
        invoiceAmount: form.invoiceAmount,
        amountToPay: form.amountToPay,
        paymentDueDate: form.paymentDueDate,
        ledgerHead: FIXED_LEDGER_HEAD,
        department: FIXED_DEPARTMENT,
        invoiceFileUrl, piFileUrl, attachmentsUrl,
        cancelledChequeUrl, clientEmailConfirmationUrl, clientLedgerUrl
      });
      setForm(makeEmptyForm());
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
      <PageHeader title="SD Refunds" subtitle="Security Deposit refund submission" actions={<Button variant="secondary" size="sm" onClick={reload}>Refresh</Button>} />

      {!canView ? (
        <Card><div className={styles.viewOnly}>You don't have access to SD Refunds. Ask an admin to grant it via Roles & Access.</div></Card>
      ) : (
        <>
          {canSubmit && (
          <Card title="Submit a Bill">
            <form onSubmit={handleSubmit} className={styles.form}>
              <div className={styles.grid3}>
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
                  <td key="vn">{r.vendorName}</td>,
                  <td key="ia">{r.invoiceAmount}</td>,
                  <td key="ap">{r.amountToPay}</td>,
                  <td key="pd">{r.paymentDueDate}</td>,
                  <td key="if"><Link url={r.invoiceFileUrl} /></td>,
                  <td key="pf"><Link url={r.piFileUrl} /></td>,
                  <td key="dp">{r.department}</td>,
                  <td key="lh">{r.ledgerHead}</td>,
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
