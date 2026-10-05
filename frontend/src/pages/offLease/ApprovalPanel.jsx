import { useState } from 'react';
import { Button } from '../../components/ui/index.js';
import { renderCellValue } from '../../components/ui/CellValue.jsx';
import { apiErrorMessage } from '../../shared/auth/index.js';
import { decideApproval, sendBackToStage1FromApproval, decideClientToClient } from '../../services/offLease.service.js';
import { formatActionTimestamp } from '../../utils/formatDateTime.js';
import { RejectModal } from './RejectModal.jsx';
import { ClientToClientModal } from './ClientToClientModal.jsx';
import styles from './ContainerDetailPage.module.css';

/**
 * Stage 1A — Intimation Approval for ONE record, shown inline on the record
 * page. Same four outcomes and the same remarks-first modals as the Off-Lease
 * approval queue (Approve / Client to Client / Send Back / Reject), calling the
 * same service functions, so a decision made here is the decision made there.
 *
 * `canAct` is false once the gate is decided or for callers without the
 * approval permission — the panel then just shows what Stage 1 submitted and
 * what was decided.
 */
export function ApprovalPanel({ containerNo, rowNum, status, date, user, stage1Fields, canAct, onDone }) {
  const [modal, setModal] = useState(null); // 'approve' | 'reject' | 'sendBack' | 'ctc' | null
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const item = { row: [containerNo], _rowNum: rowNum };

  const close = () => { setModal(null); setError(''); };
  const run = (fn) => async (...args) => {
    setBusy(true);
    setError('');
    try {
      const message = await fn(...args);
      close();
      onDone(message === 'ALREADY_PROCESSED' ? 'This row was already actioned by someone else.' : '');
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const state = status === 'approved' ? 'Approved' : status === 'rejected' ? 'Rejected' : 'Pending';

  return (
    <section className={styles.panel}>
      <h3 className={styles.panelTitle}>Intimation approval — {state}</h3>
      {(date || user) && (
        <div className={styles.meta}>{[date ? formatActionTimestamp(date) : '', user].filter(Boolean).join(' · ')}</div>
      )}

      <div className={styles.cards}>
        {(stage1Fields || []).map((f) => (
          <div key={f.label} className={styles.row}>
            <span className={styles.rowLabel}>{f.label}</span>
            <span className={styles.rowValue}>{renderCellValue(f.value)}</span>
          </div>
        ))}
      </div>

      {canAct && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          <Button size="sm" variant="primary" onClick={() => setModal('approve')}>Approve</Button>
          <Button size="sm" variant="secondary" onClick={() => setModal('ctc')}>Client to Client</Button>
          <Button size="sm" variant="secondary" onClick={() => setModal('sendBack')}>Send Back</Button>
          <Button size="sm" variant="danger" onClick={() => setModal('reject')}>Reject</Button>
        </div>
      )}

      <RejectModal
        open={modal === 'approve'}
        item={item}
        submitting={busy}
        error={error}
        onClose={close}
        onSubmit={run((remarks) => decideApproval(containerNo, 'Approved', remarks, rowNum))}
        titleWord="Approve"
        placeholder="Any remarks for this approval? (optional)"
        submitLabel="Approve"
        variant="primary"
      />
      <RejectModal
        open={modal === 'reject'}
        item={item}
        submitting={busy}
        error={error}
        onClose={close}
        onSubmit={run((remarks) => decideApproval(containerNo, 'Rejected', remarks, rowNum))}
      />
      <RejectModal
        open={modal === 'sendBack'}
        item={item}
        submitting={busy}
        error={error}
        onClose={close}
        onSubmit={run((remarks) => sendBackToStage1FromApproval(containerNo, remarks, rowNum))}
        titleWord="Send Back"
        placeholder="What needs fixing before this can be resubmitted? (optional)"
        submitLabel="Send Back"
        variant="secondary"
      />
      <ClientToClientModal
        open={modal === 'ctc'}
        item={item}
        submitting={busy}
        error={error}
        onClose={close}
        onSubmit={run((clientName, remarks) => decideClientToClient(containerNo, clientName, remarks, rowNum))}
      />
    </section>
  );
}
