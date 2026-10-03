import { PageHeader, Card, Button, DataGrid } from '../../components/ui/index.js';
import { useAsync } from '../../hooks/useAsync.js';
import { usePermission } from '../../hooks/usePermission.js';
import { fetchRefunds } from '../../services/refunds.service.js';
import { RefundSubmitForm } from './RefundSubmitForm.jsx';
import styles from './RefundsPage.module.css';

function StageBadge({ status }) {
  const s = (status || '').trim();
  const cls = s === 'Approved' ? styles.stageApproved : s === 'Rejected' ? styles.stageRejected : s === 'Pending' ? styles.stagePending : styles.stageDone;
  return <span className={`${styles.stageBadge} ${cls}`}>{s || '—'}</span>;
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
  // Accounts removed from the approval chain 2026-10-03 (explicit request:
  // "HOD and CEO approv only") — CEO approving is now the final decision.
  'HOD', 'CEO',
  // Explicit request 2026-10-01 ("add the stage 6 SD refunds"): links a bill
  // to its Off-Lease container — required on every new submission now.
  'Container No',
  // Explicit request 2026-10-03 ("save this backend container no and Client
  // name and offlease id") — captured automatically from Stage 6's own
  // context, blank for bills raised from this standalone page instead.
  'Client Name', 'Off-Lease ID'
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

  return (
    <>
      <PageHeader title="SD Refunds" subtitle="Security Deposit refund submission" actions={<Button variant="secondary" size="sm" onClick={reload}>Refresh</Button>} />

      {!canView ? (
        <Card><div className={styles.viewOnly}>You don't have access to SD Refunds. Ask an admin to grant it via Roles & Access.</div></Card>
      ) : (
        <>
          {canSubmit && (
          <Card title="Submit a Bill">
            <RefundSubmitForm onSubmitted={reload} />
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
                  <td key="cn">{r.containerNo || '—'}</td>,
                  <td key="clnm">{r.clientName || '—'}</td>,
                  <td key="oid">{r.offLeaseId || '—'}</td>
                ]}
              />
            </Card>
          </div>
        </>
      )}
    </>
  );
}
