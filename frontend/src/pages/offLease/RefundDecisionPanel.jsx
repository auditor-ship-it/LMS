import { useState } from 'react';
import { Button } from '../../components/ui/index.js';
import { apiErrorMessage } from '../../shared/auth/index.js';
import { submitRefundApprovalDecision } from '../../services/refunds.service.js';
import { SdRefundDetails } from '../stages/StageDetailModal.jsx';
import styles from './ContainerDetailPage.module.css';

/**
 * Stage 6A (HOD) / 6B (CEO) for ONE record, inline on the record page: the SD
 * Refund that was submitted, and — when it is this stage's turn and the caller
 * holds the permission — Approve / Reject with the same remarks modal and the
 * same decision call the Off-Lease approval queue uses.
 *
 * `which` is 'hod' or 'ceo'. The buttons only show while the refund is waiting
 * on THIS stage (entry.currentStage === which) and `canAct` is true; otherwise
 * the panel is read-only and says why.
 */
export function RefundDecisionPanel({ which, entry, canAct, onDone }) {
  const [remarks, setRemarks] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const label = which === 'hod' ? 'HOD' : 'CEO';

  if (!entry) {
    return <section className={styles.panel}><p className={styles.empty}>No SD refund has been submitted for this record yet.</p></section>;
  }

  const myTurn = entry.currentStage === which;
  const status = (which === 'hod' ? entry.hodStatus : entry.ceoStatus) || 'Pending';

  /* Decides straight from the buttons — the remarks box is right here, so there
     is no pop-up in between. A rejection needs a reason (it is sent to the
     submitter and stops the workflow), so that one asks for it first. */
  const decide = async (decision) => {
    const text = remarks.trim();
    if (decision === 'rejected' && !text) {
      setError('Add a remark saying why this is being rejected.');
      return;
    }
    setBusy(decision);
    setError('');
    try {
      const result = await submitRefundApprovalDecision({
        rowNum: entry._rowNum, stage: which, decision, remarks: text
      });
      if (result === 'INVALID_STATE') {
        setError("Already decided, or not this stage's turn — refresh and try again.");
      } else {
        setRemarks('');
        onDone();
      }
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.panel}>
      <h3 className={styles.panelTitle}>{label} approval — {status}</h3>
      <SdRefundDetails
        entry={entry}
        /* HOD's decision (status, approver email, timestamp, remarks) is shown
           only on the CEO panel — the CEO needs it, the HOD panel does not. Neither
           panel shows the CEO's own decision fields. */
        always={which === 'ceo' ? ['hodStatus', 'hodApprover', 'hodDate', 'hodRemarks'] : []}
        hide={which === 'hod'
          ? ['hodStatus', 'hodApprover', 'hodDate', 'hodRemarks', 'ceoStatus', 'ceoApprover', 'ceoDate', 'ceoRemarks']
          : ['ceoStatus', 'ceoApprover', 'ceoDate', 'ceoRemarks']}
      />

      {myTurn && canAct && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4, fontWeight: 700, color: 'var(--text-3)' }}>
              Remarks (required to reject)
            </span>
            <textarea
              value={remarks}
              onChange={(e) => { setRemarks(e.target.value); if (error) setError(''); }}
              rows={3}
              placeholder={which === 'hod' ? 'Add a remark for the CEO / submitter…' : 'Add a remark for the submitter…'}
              style={{ width: '100%', boxSizing: 'border-box', padding: '10px 12px', border: '1.5px solid var(--line)', borderRadius: 'var(--r-md)', background: 'var(--surface)', color: 'var(--text)', font: 'inherit', resize: 'vertical' }}
            />
          </label>
          {error && <span style={{ fontSize: 12, color: 'var(--error)' }}>{error}</span>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button size="sm" variant="primary" loading={busy === 'approved'} disabled={!!busy} onClick={() => decide('approved')}>Approve</Button>
            <Button size="sm" variant="danger" loading={busy === 'rejected'} disabled={!!busy} onClick={() => decide('rejected')}>Reject</Button>
          </div>
        </div>
      )}
      {myTurn && !canAct && (
        <p className={styles.empty}>Waiting for {label} sign-off. You don&apos;t have {label} approval permission.</p>
      )}
      {!myTurn && status === 'Pending' && (
        <p className={styles.empty}>
          {which === 'ceo' ? 'Waiting for HOD approval first.' : 'This refund has already moved past HOD.'}
        </p>
      )}

    </section>
  );
}
