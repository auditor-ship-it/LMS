import { useEffect, useRef, useState } from 'react';
import { Modal, Button, FileUpload } from '../../components/ui/index.js';
import styles from './OffLeaseModal.module.css';

const ACCEPT = '.pdf,.jpg,.jpeg,.png,.gif,.eml,.msg';

/**
 * Lease Expiry's "Off-Lease" confirmation — captures who requested/handled
 * it (Person Name, required) and an optional Remarks before the container
 * actually enters Off-Lease Stage 1. Same shape as Stage 1's own HoldModal
 * (frontend/src/pages/stages/HoldModal.jsx) and Stage 1A's RejectModal
 * (frontend/src/pages/offLease/RejectModal.jsx) — captured once, at
 * creation time, since Off-Lease Tracking has no other narrative field
 * until Stage 1's own form is filled in later.
 *
 * Doubles as the BULK version: pass `items` (array) instead of `item` and
 * the same Person Name/Remarks applies to every selected container — same
 * convention as RenewModal.jsx/RejectModal.jsx.
 *
 * Email Confirmation (required) — explicit request 2026-11-16 ("add the
 * one emails confirmation upload"): the client's own email confirming this
 * off-lease, uploaded here alongside Person Name/Remarks and written to
 * the SAME new tracking row (OL_EMAIL_CONFIRMATION_COL in
 * offlease.service.js). `onSubmit` receives the already-uploaded file's
 * URL as `emailConfirmationUrl` — uploading is this modal's own job so the
 * caller (LeaseExpiryPage.jsx) doesn't need its own upload step.
 *
 * "Location Change" checkbox — explicit follow-up 2026-11-16 ("location
 * change click check box agar yah click karuga tabhi new lease navigatio
 * add karo"): unchecked by default, a plain Off-Lease exactly as before.
 * Checked, this container ALSO gets queued into the new "New Lease"
 * sidebar page (pending redeployment at a new location) — see
 * newLeaseQueue.service.js on the backend. Bulk mode has no checkbox of
 * its own; it's single-container-only, same reasoning the Email
 * Confirmation upload already applies per-container in bulk (one shared
 * file for every selected container), kept simple since a location change
 * is inherently a one-container-at-a-time decision.
 */
export function OffLeaseModal({ open, item, items, submitting, error, onClose, onSubmit, onUploadFile }) {
  const [personName, setPersonName] = useState('');
  const [remarks, setRemarks] = useState('');
  const [emailConfirmationFile, setEmailConfirmationFile] = useState(null);
  const [locationChange, setLocationChange] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const bulk = Array.isArray(items);
  /* BUG FOUND AND FIXED 2026-11-24 (live report — "Could not upload the
     email confirmation" shown even though the upload succeeded): the Submit
     button is only disabled once `uploading` state is set, and React state
     updates are not synchronous — a quick double-click on a slow network
     could fire handleSubmit twice before the first render re-disables the
     button, sending the SAME file to Drive twice at once. The second of the
     two concurrent submits then raced the first one's record creation
     (onSubmit), and its own failure was reported as an upload failure even
     though the Drive upload itself had gone through fine. A plain ref (not
     state) blocks re-entry the instant the first click starts, with no
     render delay to race. */
  const submittingRef = useRef(false);

  useEffect(() => {
    if (open) { setPersonName(''); setRemarks(''); setEmailConfirmationFile(null); setLocationChange(false); setUploadError(''); submittingRef.current = false; }
  }, [open, item, items]);

  if (!bulk && !item) return null;
  if (bulk && !items.length) return null;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submittingRef.current) return;
    if (!personName.trim()) return;
    if (!emailConfirmationFile) { setUploadError('Email confirmation is required.'); return; }
    submittingRef.current = true;
    setUploadError('');
    setUploading(true);
    try {
      const emailConfirmationUrl = await onUploadFile(emailConfirmationFile);
      onSubmit({ personName: personName.trim(), remarks: remarks.trim(), emailConfirmationUrl, locationChange });
    } catch (e2) {
      setUploadError('Could not upload the email confirmation — try again.');
      submittingRef.current = false;
    } finally {
      setUploading(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={bulk ? `Off-Lease — ${items.length} containers` : 'Off-Lease Container'}
      width="440px"
    >
      <form onSubmit={handleSubmit} className={styles.form}>
        {bulk ? (
          <div className={styles.field}>
            <span className={styles.label}>Containers ({items.length})</span>
            <div className={styles.bulkList}>{items.map((it) => it.row?.[0]).join(', ')}</div>
          </div>
        ) : (
          <label className={styles.field}>
            <span className={styles.label}>Container</span>
            <input type="text" value={item.row?.[0] || ''} disabled />
          </label>
        )}
        <label className={styles.field}>
          <span className={styles.label}>Person Name *</span>
          <input
            type="text"
            value={personName}
            onChange={(e) => setPersonName(e.target.value)}
            placeholder="Who requested this off-lease?"
            required
            autoFocus
          />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Remarks / Comment</span>
          <textarea
            rows={3}
            value={remarks}
            onChange={(e) => setRemarks(e.target.value)}
            placeholder="Optional"
          />
        </label>
        <div className={styles.field}>
          <span className={styles.label}>Email Confirmation *</span>
          <FileUpload
            label={emailConfirmationFile ? `Selected: ${emailConfirmationFile.fileName}` : 'Upload email confirmation'}
            accept={ACCEPT}
            onSelected={setEmailConfirmationFile}
          />
        </div>
        {!bulk && (
          <label className={styles.checkboxField}>
            <input type="checkbox" checked={locationChange} onChange={(e) => setLocationChange(e.target.checked)} />
            <span>Location Change — this container will be redeployed at a new location once off-leased</span>
          </label>
        )}

        {(error || uploadError) && <p className={styles.error}>{error || uploadError}</p>}

        <div className={styles.footer}>
          <Button type="button" variant="secondary" onClick={onClose} disabled={submitting || uploading}>Cancel</Button>
          <Button type="submit" variant="primary" loading={submitting || uploading}>
            {bulk ? `Off-Lease ${items.length}` : 'Off-Lease'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
