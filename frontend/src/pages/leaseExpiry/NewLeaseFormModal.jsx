import { useState } from 'react';
import { Modal, Button, FileUpload } from '../../components/ui/index.js';
import { uploadStageFile } from '../../services/upload.service.js';
import { apiErrorMessage } from '../../shared/auth/index.js';
import styles from './OffLeaseModal.module.css';

const ACCEPT = '.pdf,.jpg,.jpeg,.png,.gif';

const SIZE_OPTIONS = ['10 FT', '20 FT', '30 FT'];
const TYPE_OPTIONS = ['DRY Container', 'Reefer Container', 'SITE CABIN', 'ISO TANK', 'POP'];
const BILLING_CYCLE_OPTIONS = ['Monthly', 'Daily'];
const BILLING_TYPE_OPTIONS = ['Advance', 'End'];
const TRANSPORT_SCOPE_OPTIONS = ['Client Scope', 'Crystal Scope'];

const FIELDS = [
  { key: 'customerName', label: 'Customer Name', type: 'text', required: true },
  { key: 'size', label: 'Size', type: 'select', options: SIZE_OPTIONS, required: true },
  { key: 'type', label: 'Type', type: 'select', options: TYPE_OPTIONS, required: true },
  { key: 'location', label: 'Location', type: 'text', required: true },
  { key: 'city', label: 'City', type: 'text' },
  { key: 'deployedDate', label: 'Deployed Date', type: 'date', required: true },
  { key: 'agreementValidUpto', label: 'Agreement Valid Upto', type: 'date', required: true },
  { key: 'rate', label: 'Rate', type: 'number' },
  { key: 'billingCycle', label: 'Billing Cycle', type: 'select', options: BILLING_CYCLE_OPTIONS },
  { key: 'billingType', label: 'Billing Type', type: 'select', options: BILLING_TYPE_OPTIONS },
  { key: 'clientCode', label: 'Client Code', type: 'text' },
  { key: 'productCode', label: 'Product Code', type: 'text' },
  { key: 'po', label: 'PO', type: 'text' },
  { key: 'poValidity', label: 'PO Validity', type: 'date' },
  { key: 'salePerson', label: 'Sale Person', type: 'text' },
  // Explicit follow-up 2026-11-16 ("transportation client scope and
  // crystal scope... crystal scope yes then transportation po upload") —
  // the PO upload itself is conditional, handled separately below, not as
  // a plain FIELDS entry (file fields aren't part of this generic loop).
  { key: 'transportationScope', label: 'Transportation', type: 'select', options: TRANSPORT_SCOPE_OPTIONS }
];

/** "dd-mm-yyyy" / "dd/mm/yyyy" (how the Deployed sheet's own dates read
 *  back) -> "yyyy-mm-dd" (what an <input type="date"> needs) — anything
 *  else (blank, already ISO, unparsable) passes through unchanged. */
function toDateInputValue(s) {
  const m = String(s || '').trim().match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (!m) return s || '';
  const [, d, mo, y] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

/** Explicit request 2026-11-16 ("old data fetch hone chahiye"): the new
 *  deployment form starts PRE-FILLED from the old row (see
 *  newLeaseQueue.service.js's own oldSnapshot, captured at Off-Lease time)
 *  rather than blank — most of a relocated container's own details (size,
 *  type, rate, client, dates) carry over unchanged; only the fields that
 *  actually change for a new location need editing. Every field here stays
 *  fully editable — this is a starting point, not a lock. */
function prefillFromOld(old) {
  return {
    customerName: old.clientName || '',
    size: old.size || '',
    type: old.type || '',
    location: old.location || '',
    deployedDate: toDateInputValue(old.deployedDate),
    agreementValidUpto: toDateInputValue(old.validUpto),
    rate: old.rate ?? '',
    clientCode: old.clientCode || ''
  };
}

/**
 * Fills the NEW deployment's own details for a container queued via the
 * Off-Lease Container modal's Location Change checkbox — explicit request
 * 2026-11-16. The old row (reference only, shown alongside) is never
 * edited; submitting this appends a brand-new row on the Deployed sheet.
 */
export function NewLeaseFormModal({ entry, onClose, onSubmitted }) {
  const [values, setValues] = useState(() => prefillFromOld(entry?.oldSnapshot || {}));
  const [agreementPdf, setAgreementPdf] = useState(null);
  const [poPdf, setPoPdf] = useState(null);
  const [gstFile, setGstFile] = useState(null);
  const [cancelledChequeFile, setCancelledChequeFile] = useState(null);
  const [transportationPoFile, setTransportationPoFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Explicit follow-up 2026-11-16 ("i am click the this all old dat show
  // open"): the summary line only showed 5 of the 8 fields actually
  // captured in oldSnapshot — click it to expand every field, not just a
  // short summary.
  const [oldExpanded, setOldExpanded] = useState(false);

  if (!entry) return null;
  const old = entry.oldSnapshot || {};

  const setField = (key, v) => setValues((prev) => ({ ...prev, [key]: v }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    const missing = FIELDS.filter((f) => f.required && !String(values[f.key] || '').trim());
    if (missing.length) { setError(`Please fill in: ${missing.map((f) => f.label).join(', ')}.`); return; }
    setBusy(true);
    setError('');
    try {
      const [agreementPdfUrl, poPdfUrl, gstUrl, cancelledChequeUrl, transportationPoUrl] = await Promise.all([
        agreementPdf ? uploadStageFile(agreementPdf) : '',
        poPdf ? uploadStageFile(poPdf) : '',
        gstFile ? uploadStageFile(gstFile) : '',
        cancelledChequeFile ? uploadStageFile(cancelledChequeFile) : '',
        values.transportationScope === 'Crystal Scope' && transportationPoFile ? uploadStageFile(transportationPoFile) : ''
      ]);
      await onSubmitted(entry.id, {
        containerNo: entry.containerNo, ...values,
        agreementPdf: agreementPdfUrl, poPdf: poPdfUrl, gst: gstUrl, cancelledCheque: cancelledChequeUrl,
        transportationPo: transportationPoUrl
      });
    } catch (e2) {
      setError(apiErrorMessage(e2));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={`New Lease — ${entry.containerNo}`} width="760px">
      <form onSubmit={handleSubmit} className={styles.form}>
        <div className={styles.field}>
          <button
            type="button"
            className={styles.oldDeploymentToggle}
            onClick={() => setOldExpanded((v) => !v)}
          >
            <span className={styles.label}>Old deployment (reference only) — click to {oldExpanded ? 'collapse' : 'show all'}</span>
          </button>
          {!oldExpanded ? (
            <div className={styles.bulkList}>
              {old.clientName || '—'} · {old.size || '—'} {old.type || ''} · {old.location || '—'} · Valid upto {old.validUpto || '—'}
            </div>
          ) : (
            <div className={styles.bulkList}>
              <div>Client Name: {old.clientName || '—'}</div>
              <div>Client Code: {old.clientCode || '—'}</div>
              <div>Size: {old.size || '—'}</div>
              <div>Type: {old.type || '—'}</div>
              <div>Location: {old.location || '—'}</div>
              <div>Deployed Date: {old.deployedDate || '—'}</div>
              <div>Valid Upto: {old.validUpto || '—'}</div>
              <div>Rate: {old.rate ?? '—'}</div>
            </div>
          )}
        </div>

        <div className={styles.formGrid}>
          {FIELDS.map((f) => (
            <label key={f.key} className={styles.field}>
              <span className={styles.label}>{f.label}{f.required ? ' *' : ''}</span>
              {f.type === 'select' ? (
                <select
                  value={values[f.key] || ''}
                  onChange={(e) => setField(f.key, e.target.value)}
                  required={f.required}
                >
                  <option value="">Select…</option>
                  {f.options.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                </select>
              ) : (
                <input
                  type={f.type}
                  step={f.type === 'number' ? 'any' : undefined}
                  value={values[f.key] || ''}
                  onChange={(e) => setField(f.key, e.target.value)}
                  required={f.required}
                />
              )}
            </label>
          ))}

          {values.transportationScope === 'Crystal Scope' && (
            <div className={styles.field}>
              <span className={styles.label}>Transportation PO</span>
              <FileUpload
                label={transportationPoFile ? `Selected: ${transportationPoFile.fileName}` : 'Upload transportation PO'}
                accept={ACCEPT}
                onSelected={setTransportationPoFile}
              />
            </div>
          )}
        </div>

        <div className={styles.formGrid}>
          <div className={styles.field}>
            <span className={styles.label}>Agreement PDF</span>
            <FileUpload
              label={agreementPdf ? `Selected: ${agreementPdf.fileName}` : 'Upload agreement'}
              accept={ACCEPT}
              onSelected={setAgreementPdf}
            />
          </div>
          <div className={styles.field}>
            <span className={styles.label}>PO PDF</span>
            <FileUpload
              label={poPdf ? `Selected: ${poPdf.fileName}` : 'Upload PO'}
              accept={ACCEPT}
              onSelected={setPoPdf}
            />
          </div>
          <div className={styles.field}>
            <span className={styles.label}>GST</span>
            <FileUpload
              label={gstFile ? `Selected: ${gstFile.fileName}` : 'Upload GST'}
              accept={ACCEPT}
              onSelected={setGstFile}
            />
          </div>
          <div className={styles.field}>
            <span className={styles.label}>Cancelled Cheque</span>
            <FileUpload
              label={cancelledChequeFile ? `Selected: ${cancelledChequeFile.fileName}` : 'Upload cancelled cheque'}
              accept={ACCEPT}
              onSelected={setCancelledChequeFile}
            />
          </div>
        </div>

        {error && <p className={styles.error}>{error}</p>}

        <div className={styles.footer}>
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy}>Submit</Button>
        </div>
      </form>
    </Modal>
  );
}
