import { useEffect, useState } from 'react';
import { Modal, Button } from '../../components/ui/index.js';
import { STAGE_FIELDS } from './stageFields.js';
import { fetchStageDetail } from '../../services/stage.service.js';
import {
  Field, CollapsibleSection, CostReferencePanel, TransportInvoiceNote,
  InspectionReferenceTable, Stage1DataNote
} from './StageDetailModal.jsx';
import styles from './StageDetailModal.module.css';

const FIELDS = STAGE_FIELDS[5] || [];
const emptyValues = () => Object.fromEntries(FIELDS.map((f) => [f.key, '']));

/**
 * Fill Stage 5 (Final Billing) once, submit it to every selected container's
 * own row — explicit request 2026-11-14 ("multiple selct the form and fil
 * one form only multiple"). Each container keeps its own Stage 1-4 reference
 * data (fetched per-container, since a shared form must not imply they share
 * those figures) in its own collapsible section, same reference panels the
 * single-record Stage 5 modal shows.
 */
export function BulkStage5Modal({ open, items, submitting, error, onClose, onSubmit }) {
  const [values, setValues] = useState(emptyValues);
  const [pendingFiles, setPendingFiles] = useState({});
  const [refData, setRefData] = useState({}); // containerNo -> detail | 'error' | undefined (loading)

  useEffect(() => {
    if (!open) return;
    setValues(emptyValues());
    setPendingFiles({});
    setRefData({});
    let cancelled = false;
    (async () => {
      for (const it of items) {
        if (cancelled) return;
        try {
          const detail = await fetchStageDetail(it.containerNo, 5, it.rowNum);
          if (!cancelled) setRefData((prev) => ({ ...prev, [it.containerNo]: detail }));
        } catch (e) {
          if (!cancelled) setRefData((prev) => ({ ...prev, [it.containerNo]: 'error' }));
        }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const setField = (key, v) => setValues((prev) => ({ ...prev, [key]: v }));

  const handleSubmit = (e) => {
    e.preventDefault();
    onSubmit({ values, pendingFiles });
  };

  return (
    <Modal open onClose={onClose} title={`Final Billing — ${items.length} containers`} width="760px">
      <form onSubmit={handleSubmit}>
        <div className={styles.fmsWrap} style={{ marginBottom: 16 }}>
          <p className={styles.sectionHint}>Containers in this submission</p>
          <ul>
            {items.map((it) => <li key={it.containerNo}>{it.containerNo}</li>)}
          </ul>
        </div>

        <div className={styles.fieldGrid}>
          {FIELDS.map((f) => (
            <Field
              key={f.key}
              field={f}
              value={values[f.key]}
              pendingFileName={pendingFiles[f.key]?.fileName}
              onChange={(v) => setField(f.key, v)}
              onFile={(payload) => { setPendingFiles((p) => ({ ...p, [f.key]: payload })); setField(f.key, payload.fileName); }}
              disabled={submitting}
            />
          ))}
        </div>

        {items.map((it) => {
          const data = refData[it.containerNo];
          return (
            <CollapsibleSection key={it.containerNo} title={`Reference Data (Stage 1-4) — ${it.containerNo}`}>
              {!data ? (
                <p className={styles.sectionHint}>Loading…</p>
              ) : data === 'error' ? (
                <p className={styles.sectionHint}>Could not load this container's reference data.</p>
              ) : (
                <>
                  <CostReferencePanel
                    inspectionCost={data?._inspectionCost}
                    inspectionPoints={data?._inspectionPoints}
                    machinePoints={data?._machinePoints}
                    technician={data?._technician}
                  />
                  <TransportInvoiceNote invoice={data?._transportInvoice} />
                  <InspectionReferenceTable title="Container Inspection Checklist" points={data?._inspectionPoints} />
                  <InspectionReferenceTable title="Machine Check" points={data?._machinePoints} />
                  <Stage1DataNote data={data?._stage1Data} />
                </>
              )}
            </CollapsibleSection>
          );
        })}

        {error && <p className={styles.error}>{error}</p>}

        <div className={styles.actions}>
          <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button type="submit" variant="primary" loading={submitting}>
            {submitting ? 'Submitting…' : `Submit for ${items.length} containers`}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
