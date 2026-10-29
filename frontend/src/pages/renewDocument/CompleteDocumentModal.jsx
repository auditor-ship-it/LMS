import { useEffect, useRef, useState } from 'react';
import { Modal, Button } from '../../components/ui/index.js';
import { Icon } from '../../components/ui/Icon.jsx';
import styles from './Modals.module.css';

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64Data = String(reader.result).split(',')[1] || '';
      resolve({ base64Data, mimeType: file.type || 'application/octet-stream', fileName: file.name });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/** Explicit request 2026-10-28 ("do not show this [plain text link], show
 *  example this"): same "File attached / Click to replace / View" card
 *  StageDetailModal's own FileFieldInput uses for an uploaded file, not the
 *  plain FileUpload button + separate text link this replaces. Three
 *  states, same as that reference: nothing chosen/attached ("empty"), a
 *  file just picked this session but not yet uploaded ("pending" — no View,
 *  there's nothing on Drive to view yet), or already on file from a prior
 *  Save/Submit ("done" — View opens the existing Drive URL). The whole
 *  control (except View, which stops propagation) opens the file picker. */
function AttachedFileField({ pendingFile, existingUrl, accept, onSelected, onClear }) {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);

  const handleChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      onSelected(await readFileAsBase64(file));
    } finally {
      setBusy(false);
      e.target.value = '';
    }
  };

  const state = busy ? 'busy' : pendingFile ? 'pending' : existingUrl ? 'done' : 'empty';

  return (
    <label className={`${styles.attachedCard} ${styles[`attachedCard_${state}`]}`}>
      <Icon name={state === 'done' ? 'check' : 'upload'} className={styles.attachedIcon} />
      <span className={styles.attachedText}>
        {state === 'busy' && <span className={styles.attachedName}>Reading…</span>}
        {state === 'pending' && (
          <>
            <span className={styles.attachedName}>{pendingFile.fileName}</span>
            <span className={styles.attachedHint}>Not saved yet</span>
          </>
        )}
        {state === 'done' && (
          <>
            <span className={styles.attachedName}>File attached</span>
            <span className={styles.attachedHint}>Click to replace</span>
          </>
        )}
        {state === 'empty' && <span className={styles.attachedName}>Choose file</span>}
      </span>
      {state === 'done' && (
        <a
          href={existingUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={styles.attachedView}
          onClick={(e) => e.stopPropagation()}
        >
          View
        </a>
      )}
      {/* Explicit request 2026-10-29 ("by mistake file upload mujhe cancle
          kar na hai... one cross clik then cut option"): a file picked by
          mistake had no way back to empty — clicking the card again only
          opened the picker for a REPLACEMENT, never cleared it. preventDefault
          too, not just stopPropagation — this sits inside a <label>, so a
          plain click would otherwise still fire the label's own "open file
          picker" default behavior even with propagation stopped. */}
      {state === 'pending' && onClear && (
        <button
          type="button"
          className={styles.attachedClear}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClear(); }}
          aria-label="Remove selected file"
          title="Remove selected file"
        >
          <Icon name="x" size="sm" />
        </button>
      )}
      <input ref={inputRef} type="file" accept={accept} onChange={handleChange} disabled={busy} hidden />
    </label>
  );
}

const ACCEPT = '.pdf,.jpg,.jpeg,.png,.gif,.xls,.xlsx';

const EMPTY_FORM = {
  renewedDate: '', validTill: '', remarks: '', poNo: '', poValidity: '', poValue: '', billingCycle: '',
  signedCopy: null, // {base64Data, mimeType, fileName}
  poFile: null
};

/** Whatever's already in `item.draft` (a prior Save, or existing PO/Billing
 *  Cycle values already on the row — see RenewDocumentPage.jsx's openDoc)
 *  turned into this form's shape. Dates arrive as ISO strings (the backend
 *  always writes new Date(x).toISOString()) — <input type="date"> needs
 *  plain YYYY-MM-DD. */
function toDateInputValue(v) {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}
function formFromDraft(draft) {
  if (!draft) return EMPTY_FORM;
  return {
    renewedDate: toDateInputValue(draft.renewedDate),
    validTill: toDateInputValue(draft.validTill),
    remarks: draft.remarks || '',
    poNo: draft.poNo || '',
    poValidity: toDateInputValue(draft.poValidity),
    poValue: draft.poValue || '',
    billingCycle: draft.billingCycle || '',
    signedCopy: null,
    poFile: null,
    // Explicit request 2026-10-28: a Sent-Back record already carries a
    // previously-uploaded file — link to it (new tab) rather than re-upload
    // being the only way to see what's already on file. Not re-sent on
    // Save/Submit unless a NEW file is chosen (handleDocSubmit/handleDocSave
    // only upload when payload.signedCopy/poFile is set) — these two are
    // display-only.
    existingSignedCopyUrl: draft.signedCopyUrl || '',
    existingPoFileUrl: draft.poFileUrl || ''
  };
}

/**
 * "Complete Document Stage" — Documents tab's row action. Two ways to leave
 * this form, explicit request 2026-09-28:
 *   - Save (onSave -> saveRenewalDraft -> POST .../save-document-draft):
 *     persists whatever's filled in as a draft, nothing required, the
 *     container STAYS in Documents Pending and can be reopened later —
 *     reopening pre-fills from `item.draft` (a prior save, or PO/Billing
 *     Cycle values the row already had) instead of starting blank.
 *   - Submit (onSubmit -> submitDocumentCompletion ->
 *     POST .../complete-document-stage): the existing, final action —
 *     completes the renewal and clears the container out of Pending.
 * Both send the same shaped payload; the signed copy / PO file are uploaded
 * to Drive first either way (RenewDocumentPage's handleDocSubmit/
 * handleDocSave) and their resulting URLs sent in place of signedCopy/poFile.
 *
 * Also doubles as the BULK version: pass `items` (an array, one entry per
 * selected container) instead of `item`. One form, filled once — every
 * field, INCLUDING the uploaded signed copy/PO file, applies identically to
 * every container in the list (e.g. one PO/agreement batch covering several
 * containers). `item` and `items` are mutually exclusive; bulk has no single
 * container's draft to pre-fill from, so it always starts blank.
 */
export function CompleteDocumentModal({ open, item, items, submitting, error, onClose, onSubmit, onSave }) {
  const bulk = Array.isArray(items);
  const [form, setForm] = useState(() => (bulk ? EMPTY_FORM : formFromDraft(item?.draft)));

  useEffect(() => {
    if (open) setForm(bulk ? EMPTY_FORM : formFromDraft(item?.draft));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item, items]);

  if (!bulk && !item) return null;
  if (bulk && !items.length) return null;

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const handleSubmit = (e) => {
    e.preventDefault();
    onSubmit(form);
  };
  const handleSave = () => onSave(form);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={bulk ? `Update Agreement — ${items.length} containers` : 'Update Agreement'}
      width="540px"
    >
      <form onSubmit={handleSubmit} className={styles.form}>
        {bulk ? (
          <div className={styles.field}>
            <span className={styles.label}>Containers ({items.length})</span>
            <div className={styles.bulkList}>{items.map((it) => it.containerNo).join(', ')}</div>
          </div>
        ) : (
          <label className={styles.field}>
            <span className={styles.label}>Container</span>
            <input type="text" value={item.containerNo || ''} disabled />
          </label>
        )}

        {/* Explicit request 2026-09-29 (approval workflow), relabelled
            2026-10-10 ("Reject" -> "Send Back" — only the displayed wording
            changed that day, the stored approvalStatus value stayed
            'Rejected'), then 2026-10-29 ("this not reject iam send back
            button") the STORED value itself was renamed to 'Sent Back' too
            — accepting either here so a row already sent back before that
            change still shows this banner (same isSentBack reasoning as
            RenewDocumentPage.jsx's own helper): Pushpa sent this one back —
            say why, front and centre, so the submitter isn't wondering why
            a "completed" Submit is back here to redo. */}
        {!bulk && (item?.draft?.approvalStatus === 'Sent Back' || item?.draft?.approvalStatus === 'Rejected') && (
          <p className={styles.error}>
            Sent back by Pushpa{item.draft.approvalRemarks ? `: ${item.draft.approvalRemarks}` : ' — no remarks given.'} Fix and Submit again.
          </p>
        )}

        {/* Explicit request 2026-09-28: this container was already Saved as a
            draft (not yet Submitted) — say so, and when, so reopening this
            form doesn't look identical to a fresh, never-touched one. */}
        {!bulk && item?.draft?.submittedDate && (
          <p className={styles.hint}>
            Draft saved — last updated {new Date(item.draft.submittedDate).toLocaleString()}. Still pending; edit and
            Save again, or Submit. Note: even after Submit, this won't disappear from the list or show its Agreement/PO
            PDF until Pushpa approves it (Renew Approval Pending).
          </p>
        )}

        <div className={styles.grid2}>
          <label className={styles.field}>
            <span className={styles.label}>Renewed Date *</span>
            <input type="date" value={form.renewedDate} onChange={set('renewedDate')} required />
          </label>
          <label className={styles.field}>
            {/* NOT required — explicit request 2026-10-03 ("this is not
                complusoly"): same reasoning as Signed Copy/PO below — a
                renewal can go through on a PO basis alone with no agreement,
                so there's no agreement expiry date to give. */}
            <span className={styles.label}>Agreement Valid Till</span>
            <input type="date" value={form.validTill} onChange={set('validTill')} />
          </label>
        </div>

        {/* Neither this nor the PO fields below are individually mandatory —
            a renewal can go through on a PO basis with no signed agreement,
            or on an agreement basis with no PO. Provide whichever this
            container is actually being renewed on; the backend only needs
            at least one of the two before Documents Pending can clear. */}
        {/* Not a <label> like the other fields — AttachedFileField renders its
            OWN <label> (it must, to wrap its hidden file input), and nesting
            a <label> inside another makes clicking this field's caption text
            also open the file picker. */}
        <div className={styles.field}>
          <span className={styles.label}>Signed Copy (Agreement basis)</span>
          <AttachedFileField
            pendingFile={form.signedCopy}
            existingUrl={form.existingSignedCopyUrl}
            accept={ACCEPT}
            onSelected={(file) => setForm((f) => ({ ...f, signedCopy: file }))}
            onClear={() => setForm((f) => ({ ...f, signedCopy: null }))}
          />
        </div>

        <div className={styles.grid2}>
          <label className={styles.field}>
            <span className={styles.label}>PO No (PO basis)</span>
            <input type="text" value={form.poNo} onChange={set('poNo')} />
          </label>
          <div className={styles.field}>
            <span className={styles.label}>PO File (PO basis)</span>
            <AttachedFileField
              pendingFile={form.poFile}
              existingUrl={form.existingPoFileUrl}
              accept={ACCEPT}
              onSelected={(file) => setForm((f) => ({ ...f, poFile: file }))}
              onClear={() => setForm((f) => ({ ...f, poFile: null }))}
            />
          </div>
        </div>

        <div className={styles.grid2}>
          <label className={styles.field}>
            <span className={styles.label}>PO Valid Date</span>
            <input type="date" value={form.poValidity} onChange={set('poValidity')} />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>PO Value</span>
            <input type="number" step="any" value={form.poValue} onChange={set('poValue')} placeholder="e.g. 450000" />
          </label>
        </div>

        <label className={styles.field}>
          <span className={styles.label}>Billing Cycle</span>
          <select value={form.billingCycle} onChange={set('billingCycle')}>
            <option value="">Select…</option>
            <option value="Monthly">Monthly</option>
            <option value="Daily">Daily</option>
          </select>
        </label>

        <label className={styles.field}>
          <span className={styles.label}>Remarks</span>
          <textarea value={form.remarks} onChange={set('remarks')} rows={3} />
        </label>

        {error && <p className={styles.error}>{error}</p>}

        <div className={styles.footer}>
          <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>Cancel</Button>
          {/* type="button", not "submit" — Save is deliberately permissive
              (nothing required), so it must skip the Renewed Date/Valid Till
              inputs' native `required` validation entirely, not just this
              form's own onSubmit handler. */}
          <Button type="button" variant="secondary" loading={submitting} onClick={handleSave}>
            Save
          </Button>
          <Button type="submit" variant="primary" loading={submitting}>
            {bulk ? `Submit ${items.length}` : 'Submit'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
