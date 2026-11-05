import { useEffect, useMemo, useState } from 'react';
import { Modal, Button } from '../../components/ui/index.js';
import { uploadStageFile } from '../../services/upload.service.js';
import { saveBackfillPeriod } from '../../services/poAgreementTracker.service.js';
import { apiErrorMessage } from '../../shared/auth/index.js';
import styles from './AddPeriodModal.module.css';

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

const EMPTY_FORM = { container: '', clientName: '', type: 'Agreement', startDate: '', endDate: '', poNo: '' };

/**
 * "Add Period" — backfills one historical PO or Agreement period, explicit
 * request 2026-11-04 (see poAgreementHistory.service.js's own header
 * comment for the full reasoning: the Tracker's coverage grid only ever
 * knows ONE current date per container, so a gap from BEFORE the current
 * period has nowhere to be recorded today). Add-only — confirmed directly,
 * no edit/delete form exists on purpose; a mistake is corrected by adding
 * another, right entry, not changing this one.
 *
 * Container picker reuses the SAME `containers` list the Tracker page
 * already has loaded (every Deployed-sheet row, per
 * getPoAgreementTrackerData's own unscoped source) — no new backend lookup,
 * matching the research finding that no dedicated "search any container"
 * endpoint exists elsewhere in this app either.
 */
export function AddPeriodModal({ open, containers, initialContainer, onClose, onSaved }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [containerQuery, setContainerQuery] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  /* Opened straight from one row's own detail panel — explicit follow-up
     2026-11-04 ("add period sperate add the indivual spetare from" — "add
     period separately, [as] an individual separate form [per row]"): skips
     the search step entirely, same as clicking a suggestion would, so
     there's no chance of picking the wrong container by mistake while
     you're already looking at this one's own record. `key` on the
     <AddPeriodModal> instance below (container number, or a fixed string
     for the toolbar's unscoped one) forces React to remount and re-run
     this effect fresh each time a DIFFERENT row's "Add Period" is clicked
     — without it, re-opening for a second container while this modal had
     already been opened once would keep showing the FIRST container
     (useState's initial value only runs once per mount). */
  useEffect(() => {
    if (open && initialContainer) {
      setForm({ ...EMPTY_FORM, container: initialContainer.container, clientName: initialContainer.clientName });
      setContainerQuery(initialContainer.container);
    }
  }, [open, initialContainer]);

  const close = () => { setForm(EMPTY_FORM); setContainerQuery(''); setFile(null); setError(''); onClose(); };

  const suggestions = useMemo(() => {
    const term = containerQuery.trim().toLowerCase();
    if (!term || form.container) return [];
    return containers
      .filter((c) => c.container.toLowerCase().includes(term) || c.clientName.toLowerCase().includes(term))
      .slice(0, 8);
  }, [containers, containerQuery, form.container]);

  const pickContainer = (c) => {
    setForm((f) => ({ ...f, container: c.container, clientName: c.clientName }));
    setContainerQuery(c.container);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.container) { setError('Pick a container from the list.'); return; }
    if (!form.startDate || !form.endDate) { setError('Start date and end date are required.'); return; }
    if (form.startDate > form.endDate) { setError('Start date must be before end date.'); return; }
    setError('');
    setBusy(true);
    try {
      const fileUrl = file ? await uploadStageFile(await readFileAsBase64(file)) : '';
      await saveBackfillPeriod({
        containerNo: form.container,
        clientName: form.clientName,
        type: form.type,
        startDate: form.startDate,
        endDate: form.endDate,
        fileUrl,
        poNo: form.type === 'PO' ? form.poNo : ''
      });
      close();
      onSaved();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={close} title="Add Period — backfill PO / Agreement history" width="520px">
      <form onSubmit={handleSubmit} className={styles.form}>
        <p className={styles.hint}>
          Use this to record a PAST PO or Agreement period the Tracker's calendar can't show today
          (it only tracks the current one). This only adds a record — it never changes the current dates.
        </p>

        {!initialContainer && (
          <label className={styles.field}>
            <span className={styles.label}>Container</span>
            <input
              type="text"
              value={containerQuery}
              onChange={(e) => { setContainerQuery(e.target.value); setForm((f) => ({ ...f, container: '', clientName: '' })); }}
              placeholder="Search container or client…"
              autoComplete="off"
            />
            {suggestions.length > 0 && (
              <div className={styles.suggestions}>
                {suggestions.map((c) => (
                  <button type="button" key={c.container} className={styles.suggestionRow} onClick={() => pickContainer(c)}>
                    <strong>{c.container}</strong> <span>{c.clientName}</span>
                  </button>
                ))}
              </div>
            )}
          </label>
        )}

        {form.container && (
          <div className={styles.pickedRow}>
            {initialContainer ? 'Adding a period for' : 'Selected:'} <strong>{form.container}</strong> — {form.clientName || 'Unknown client'}
          </div>
        )}

        <label className={styles.field}>
          <span className={styles.label}>Type</span>
          <select value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}>
            <option value="Agreement">Agreement</option>
            <option value="PO">PO</option>
          </select>
        </label>

        {/* Explicit follow-up 2026-11-04 ("click the po one opnrthe po
            no" — "when [Type is] PO, show the PO No [field]"): only shown
            for a PO period, same as the rest of this app treats PO No as
            specific to the PO basis, never the Agreement basis. */}
        {form.type === 'PO' && (
          <label className={styles.field}>
            <span className={styles.label}>PO No</span>
            <input type="text" value={form.poNo} onChange={(e) => setForm((f) => ({ ...f, poNo: e.target.value }))} placeholder="e.g. PUR-ORD-SA-2026-00145" />
          </label>
        )}

        <div className={styles.grid2}>
          <label className={styles.field}>
            <span className={styles.label}>Start Date</span>
            <input type="date" value={form.startDate} onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))} />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>End Date</span>
            <input type="date" value={form.endDate} onChange={(e) => setForm((f) => ({ ...f, endDate: e.target.value }))} />
          </label>
        </div>

        <label className={styles.field}>
          <span className={styles.label}>File (optional)</span>
          <input type="file" accept=".pdf,.jpg,.jpeg,.png,.gif,.xls,.xlsx" onChange={(e) => setFile(e.target.files?.[0] || null)} />
          {file && <span className={styles.fileName}>{file.name}</span>}
        </label>

        {error && <p className={styles.error}>{error}</p>}

        <div className={styles.footer}>
          <Button type="button" variant="secondary" onClick={close} disabled={busy}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy}>Save Period</Button>
        </div>
      </form>
    </Modal>
  );
}
