import { useEffect, useState } from 'react';
import { Modal, Button, FileUpload } from '../../components/ui/index.js';
import styles from './Modals.module.css';

const ACCEPT = '.pdf,.jpg,.jpeg,.png,.gif,.xls,.xlsx';

const EMPTY_FORM = {
  renewedDate: '', validTill: '', remarks: '', poNo: '', poValidity: '', billingCycle: '',
  signedCopy: null, // {base64Data, mimeType, fileName}
  poFile: null
};

/**
 * "Complete Document Stage" — Documents tab's row action. Calls
 * submitDocumentCompletion -> POST /expiry/renewal/complete-document-stage;
 * the signed copy / PO file are uploaded to Drive first (RenewDocumentPage's
 * handleDocSubmit) and their resulting URLs sent in place of signedCopy/poFile.
 */
export function CompleteDocumentModal({ open, item, submitting, error, onClose, onSubmit }) {
  const [form, setForm] = useState(EMPTY_FORM);

  useEffect(() => {
    if (open) setForm(EMPTY_FORM);
  }, [open, item]);

  if (!item) return null;

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const handleSubmit = (e) => {
    e.preventDefault();
    onSubmit(form);
  };

  return (
    <Modal open={open} onClose={onClose} title="Update Agreement" width="540px">
      <form onSubmit={handleSubmit} className={styles.form}>
        <label className={styles.field}>
          <span className={styles.label}>Container</span>
          <input type="text" value={item.containerNo || ''} disabled />
        </label>

        <div className={styles.grid2}>
          <label className={styles.field}>
            <span className={styles.label}>Renewed Date *</span>
            <input type="date" value={form.renewedDate} onChange={set('renewedDate')} required />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Valid Till *</span>
            <input type="date" value={form.validTill} onChange={set('validTill')} required />
          </label>
        </div>

        <label className={styles.field}>
          <span className={styles.label}>Signed Copy *</span>
          <FileUpload
            label={form.signedCopy ? `Selected: ${form.signedCopy.fileName}` : 'Choose signed copy'}
            accept={ACCEPT}
            onSelected={(file) => setForm((f) => ({ ...f, signedCopy: file }))}
          />
        </label>

        <div className={styles.grid2}>
          <label className={styles.field}>
            <span className={styles.label}>PO No</span>
            <input type="text" value={form.poNo} onChange={set('poNo')} />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>PO File</span>
            <FileUpload
              label={form.poFile ? `Selected: ${form.poFile.fileName}` : 'Choose PO file'}
              accept={ACCEPT}
              onSelected={(file) => setForm((f) => ({ ...f, poFile: file }))}
            />
          </label>
        </div>

        <label className={styles.field}>
          <span className={styles.label}>PO Valid Date</span>
          <input type="date" value={form.poValidity} onChange={set('poValidity')} />
        </label>

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
          <Button type="submit" variant="primary" loading={submitting}>Update Agreement</Button>
        </div>
      </form>
    </Modal>
  );
}
