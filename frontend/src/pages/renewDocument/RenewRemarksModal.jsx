import { useEffect, useState } from 'react';
import { Modal, Button, RichTextEditor, renderCellValue } from '../../components/ui/index.js';
import { apiErrorMessage } from '../../shared/auth/index.js';
import { fetchRenewRemarkThread, postRenewRemark, editRenewRemark, removeRenewRemark } from '../../services/renewDocument.service.js';
import { formatActionTimestamp } from '../../utils/formatDateTime.js';
import styles from './RenewRemarksModal.module.css';

/* The submission/draft fields ApprovalPendingPage.jsx's own table appends
   after the raw sheet columns — not part of `headers`/`row` (they're
   computed per-item in expiry.service.js), so listed explicitly here, same
   order as that table reads left to right. */
const EXTRA_FIELDS = [
  ['Submitted Date', (it) => formatActionTimestamp(it.renewalSubmittedDate)],
  ['Submitted By', (it) => it.submittedBy],
  ['Draft Renewed Date', (it) => it.draftRenewedDate && formatActionTimestamp(it.draftRenewedDate)],
  ['Draft Valid Till', (it) => it.draftValidTill && formatActionTimestamp(it.draftValidTill)],
  ['Draft Signed Copy', (it) => it.draftSignedCopyUrl],
  ['Draft PO No', (it) => it.draftPoNo],
  ['Draft PO PDF', (it) => it.draftPoFileUrl],
  ['Draft Billing Cycle', (it) => it.draftBillingCycle]
];

/**
 * Renew Approval Pending's row detail + comment thread — explicit request
 * 2026-10-05 ("click the row and open then remarks comment option"), widened
 * 2026-10-07 ("click the row open and show all data"): the table needs
 * horizontal scrolling to see every column, so this shows the full record
 * vertically first, remarks below it, both in one click.
 *
 * Approve/Reject were briefly added here the same day, then explicitly asked
 * to be removed again ("remove this approval and reject upar remarks comment
 * box") — deciding stays on the table's own row buttons only; this modal is
 * read-only (the record) plus the comment thread.
 *
 * `target` is { item, headers, colIdx } (headers/colIdx = the page's own
 * visibleColIdx — every rate/amount-filtered column, which is MORE than the
 * compact table's own further-trimmed tableColIdx) — null closes the modal
 * (Modal itself unmounts its content then, so state resets for free on the
 * next open via the key prop below).
 */
export function RenewRemarksModal({ item: target, onClose }) {
  const containerNo = target?.item?.row?.[0];
  const rowNum = target?.item?._rowNum;
  return (
    <Modal open={!!target} onClose={onClose} title={target ? `${containerNo} — Details & Remarks` : ''} width="640px">
      {target && <ModalBody key={`${containerNo}::${rowNum}`} target={target} containerNo={containerNo} rowNum={rowNum} />}
    </Modal>
  );
}

function ModalBody({ target, containerNo, rowNum }) {
  const { item, headers, colIdx } = target;

  return (
    <div className={styles.wrap}>
      <div className={styles.detail}>
        {colIdx.map((ci) => (
          <div className={styles.detailRow} key={ci}>
            <span className={styles.detailLabel}>{headers[ci]}</span>
            <span className={styles.detailValue}>{renderCellValue(item.row?.[ci])}</span>
          </div>
        ))}
      </div>
      {/* Explicit request 2026-10-07 ("this old data add the header renew
          update") — the fields above are the container's existing record;
          everything below is what THIS submission is asking to change it
          to, so they need their own heading rather than reading as one
          undivided block. */}
      <p className={styles.sectionTitle}>Renew Update</p>
      <div className={styles.detail}>
        {EXTRA_FIELDS.map(([label, get]) => {
          const val = get(item);
          return (
            <div className={styles.detailRow} key={label}>
              <span className={styles.detailLabel}>{label}</span>
              <span className={styles.detailValue}>{renderCellValue(val)}</span>
            </div>
          );
        })}
      </div>

      <RemarksSection containerNo={containerNo} rowNum={rowNum} />
    </div>
  );
}

function RemarksSection({ containerNo, rowNum }) {
  const [thread, setThread] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [html, setHtml] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');

  const load = async () => {
    setLoading(true);
    setLoadError('');
    try {
      setThread(await fetchRenewRemarkThread(containerNo, rowNum));
    } catch (e) {
      setLoadError(apiErrorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const beginEdit = (r) => {
    setEditingId(r.id);
    setHtml(r.html);
    setFormError('');
  };
  const cancelEdit = () => {
    setEditingId(null);
    setHtml('');
    setFormError('');
  };

  const save = async () => {
    setFormError('');
    setBusy(true);
    try {
      if (editingId) await editRenewRemark(editingId, html);
      else await postRenewRemark(containerNo, rowNum, html);
      setHtml('');
      setEditingId(null);
      await load();
    } catch (e) {
      setFormError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (r) => {
    setLoadError('');
    setBusy(true);
    try {
      await removeRenewRemark(r.id);
      setThread((cur) => (cur || []).filter((x) => x.id !== r.id));
    } catch (e) {
      setLoadError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.remarksSection}>
      <p className={styles.sectionTitle}>Remarks</p>
      <div className={styles.thread}>
        {loading && <p className={styles.meta}>Loading…</p>}
        {loadError && <p className={styles.error}>{loadError}</p>}
        {!loading && !loadError && thread && thread.length === 0 && (
          <p className={styles.meta}>No remarks yet — be the first to add one.</p>
        )}
        {thread?.map((r) => (
          <div className={styles.entry} key={r.id}>
            <div className={styles.entryBody} dangerouslySetInnerHTML={{ __html: r.html }} />
            <div className={styles.entryFoot}>
              <span className={styles.meta}>
                {[formatActionTimestamp(r.timestamp), r.enteredBy].filter(Boolean).join(' · ')}
                {r.editedOn && ' · edited'}
              </span>
              {/* Always offered; the server rejects anyone who is not the
                  author (or a roles admin), so the UI does not need to know
                  who may act — and cannot get it wrong. */}
              <span className={styles.entryActions}>
                <button type="button" className={styles.linkAction} onClick={() => beginEdit(r)} disabled={busy}>Edit</button>
                <button type="button" className={`${styles.linkAction} ${styles.danger}`} onClick={() => remove(r)} disabled={busy}>Delete</button>
              </span>
            </div>
          </div>
        ))}
      </div>

      <div className={styles.composer}>
        <RichTextEditor
          value={html}
          onChange={setHtml}
          placeholder={editingId ? 'Edit this remark…' : 'Add a remark…'}
          disabled={busy}
        />
        {formError && <p className={styles.error}>{formError}</p>}
        <div className={styles.composerActions}>
          {editingId && (
            <Button type="button" variant="secondary" size="sm" onClick={cancelEdit} disabled={busy}>Cancel edit</Button>
          )}
          <Button type="button" size="sm" loading={busy} onClick={save}>{editingId ? 'Save edit' : 'Post remark'}</Button>
        </div>
      </div>
    </div>
  );
}
