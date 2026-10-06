import { useState } from 'react';
import { Button } from '../../components/ui/index.js';
import { renderCellValue } from '../../components/ui/CellValue.jsx';
import { useAsync } from '../../hooks/useAsync.js';
import { apiErrorMessage } from '../../shared/auth/index.js';
import { decideApproval, sendBackToStage1FromApproval, decideClientToClient } from '../../services/offLease.service.js';
import { fetchAgreementPoPdf } from '../../services/stage.service.js';
import { formatActionTimestamp } from '../../utils/formatDateTime.js';
import styles from './ContainerDetailPage.module.css';

const LABEL_STYLE = { fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4, fontWeight: 700, color: 'var(--text-3)' };
const FIELD_STYLE = {
  width: '100%', boxSizing: 'border-box', padding: '10px 12px', border: '1.5px solid var(--line)',
  borderRadius: 'var(--r-md)', background: 'var(--surface)', color: 'var(--text)', font: 'inherit'
};

function Field({ label, value }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span style={LABEL_STYLE}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', wordBreak: 'break-word' }}>
        {value == null || String(value).trim() === '' ? '—' : renderCellValue(value)}
      </span>
    </div>
  );
}

/**
 * Stage 1A — Intimation Approval for ONE record, inline on the record page.
 * Same four outcomes and the same service calls as the Off-Lease approval queue
 * (Approve / Client to Client / Send Back / Reject), but decided straight from
 * the buttons: the remarks box is on the page, so there is no pop-up in between.
 *
 * - Approve: remarks optional.
 * - Send Back and Reject: a remark is required (it tells the submitter what to
 *   fix / why it stopped), asked for before anything is sent.
 * - Client to Client: also needs the new client's name, so choosing it reveals
 *   that one extra field and a Confirm button.
 *
 * `identity` is the record's identity rows ([label, value] pairs) shown above
 * what Stage 1 submitted. `canAct` is false once the gate is decided or for
 * callers without the approval permission — the panel is then read-only.
 */
export function ApprovalPanel({ containerNo, rowNum, status, date, user, remark, identity, stage1Fields, canAct, onDone }) {
  const [remarks, setRemarks] = useState('');
  const [ctcOpen, setCtcOpen] = useState(false);
  const [clientName, setClientName] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  // Agreement / PO PDFs live on the Deployed sheet, not the tracking row.
  const { data: docs } = useAsync(() => fetchAgreementPoPdf(containerNo), [containerNo]);

  const state = status === 'approved' ? 'Approved' : status === 'rejected' ? 'Rejected' : 'Pending';

  const run = async (kind, needsRemark, call) => {
    const text = remarks.trim();
    if (needsRemark && !text) {
      setError(kind === 'reject' ? 'Add a remark saying why this is being rejected.' : 'Add a remark saying what needs fixing before it is resubmitted.');
      return;
    }
    setBusy(kind);
    setError('');
    try {
      const message = await call(text);
      onDone(message === 'ALREADY_PROCESSED' ? 'This row was already actioned by someone else.' : '');
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusy('');
    }
  };

  const approve = () => run('approve', false, (t) => decideApproval(containerNo, 'Approved', t, rowNum));
  const reject = () => run('reject', true, (t) => decideApproval(containerNo, 'Rejected', t, rowNum));
  const sendBack = () => run('sendBack', true, (t) => sendBackToStage1FromApproval(containerNo, t, rowNum));
  const confirmCtc = () => {
    if (!clientName.trim()) { setError('Enter the new client name.'); return; }
    run('ctc', false, (t) => decideClientToClient(containerNo, clientName.trim(), t, rowNum));
  };

  const gridStyle = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 14 };

  return (
    <section className={styles.panel}>
      <h3 className={styles.panelTitle}>Intimation approval — {state}</h3>
      {/* The decision itself, always visible (a dash until someone decides). */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 14 }}>
        <Field label="Approval status" value={state} />
        <Field label="Approval timestamp" value={date ? formatActionTimestamp(date) : ''} />
        <Field label="Approver email" value={user} />
        <Field label="Approval remarks" value={remark} />
      </div>

      {/* The record itself, as the approver needs to see it. */}
      <div style={gridStyle}>
        {(identity || []).map(([label, value]) => <Field key={label} label={label} value={value} />)}
        <Field label="Agreement PDF" value={docs ? docs.agreementUrl : '…'} />
        <Field label="PO PDF" value={docs ? docs.poPdfUrl : '…'} />
      </div>

      {/* What Stage 1 submitted. */}
      {(stage1Fields || []).length > 0 && (
        <>
          <h3 className={styles.panelTitle} style={{ marginTop: 6 }}>Submitted at Stage 1</h3>
          <div className={styles.cards}>
            {stage1Fields.map((f) => (
              <div key={f.label} className={styles.row}>
                <span className={styles.rowLabel}>{f.label}</span>
                <span className={styles.rowValue}>{renderCellValue(f.value)}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {canAct && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={LABEL_STYLE}>Remarks (required to reject or send back)</span>
            <textarea
              value={remarks}
              onChange={(e) => { setRemarks(e.target.value); if (error) setError(''); }}
              rows={3}
              placeholder="Add a remark for the submitter…"
              style={{ ...FIELD_STYLE, resize: 'vertical' }}
            />
          </label>

          {ctcOpen && (
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={LABEL_STYLE}>New client name *</span>
              <input
                type="text"
                value={clientName}
                onChange={(e) => { setClientName(e.target.value); if (error) setError(''); }}
                placeholder="Who is this container going to?"
                style={FIELD_STYLE}
                autoFocus
              />
            </label>
          )}

          {error && <span style={{ fontSize: 12, color: 'var(--error)' }}>{error}</span>}

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {!ctcOpen ? (
              <>
                <Button size="sm" variant="primary" loading={busy === 'approve'} disabled={!!busy} onClick={approve}>Approve</Button>
                <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => { setError(''); setCtcOpen(true); }}>Client to Client</Button>
                <Button size="sm" variant="secondary" loading={busy === 'sendBack'} disabled={!!busy} onClick={sendBack}>Send Back</Button>
                <Button size="sm" variant="danger" loading={busy === 'reject'} disabled={!!busy} onClick={reject}>Reject</Button>
              </>
            ) : (
              <>
                <Button size="sm" variant="primary" loading={busy === 'ctc'} disabled={!!busy} onClick={confirmCtc}>Confirm Client to Client</Button>
                <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => { setCtcOpen(false); setError(''); }}>Cancel</Button>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
