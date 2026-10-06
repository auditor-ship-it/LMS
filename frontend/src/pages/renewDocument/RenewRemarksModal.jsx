import { useEffect, useState } from 'react';
import { Modal, Button, RichTextEditor } from '../../components/ui/index.js';
import { apiErrorMessage } from '../../shared/auth/index.js';
import { fetchRenewRemarkThread, postRenewRemark, editRenewRemark, removeRenewRemark } from '../../services/renewDocument.service.js';
import { formatActionTimestamp } from '../../utils/formatDateTime.js';
import styles from './RenewRemarksModal.module.css';

/**
 * Renew Approval Pending's own comment thread — explicit request 2026-10-05
 * ("click the row and open then remarks comment option"). Same post/edit/
 * delete shape as Off-Lease's dashboard remarks (OrderBookView.jsx's
 * RemarkCell), as a modal rather than an inline cell since this page is a
 * plain DataGrid, not a record-per-card layout.
 *
 * `item` is { containerNo, rowNum } — null closes the modal (Modal itself
 * unmounts its content then, so the thread/editor state resets for free on
 * the next open via the key prop below).
 */
export function RenewRemarksModal({ item, onClose }) {
  return (
    <Modal open={!!item} onClose={onClose} title={item ? `Remarks — ${item.containerNo}` : ''} width="560px">
      {item && <RemarksBody key={`${item.containerNo}::${item.rowNum}`} item={item} />}
    </Modal>
  );
}

function RemarksBody({ item }) {
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
      setThread(await fetchRenewRemarkThread(item.containerNo, item.rowNum));
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
      else await postRenewRemark(item.containerNo, item.rowNum, html);
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
    <div className={styles.wrap}>
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
