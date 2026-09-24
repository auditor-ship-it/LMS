import { Fragment, useEffect, useMemo, useState } from 'react';
import { jsPDF } from 'jspdf';
import { Button } from '../../components/ui/Button.jsx';
import { renderCellValue } from '../../components/ui/CellValue.jsx';
import { Icon } from '../../components/ui/Icon.jsx';
import { LoadingState } from '../../components/ui/LoadingState.jsx';
import { ErrorState } from '../../components/ui/ErrorState.jsx';
import { RichTextEditor } from '../../components/ui/RichTextEditor.jsx';
import { apiErrorMessage } from '../../shared/auth/index.js';
import { fetchStageDetail, fetchNextLeaseId, submitStage, submitMoveToStage, submitSendBack, submitSendBackFromBilling } from '../../services/stage.service.js';
import { lookupContainer, fetchRemarkThread, postRemark, editRemark, removeRemark } from '../../services/offLease.service.js';
import { RejectModal } from '../offLease/RejectModal.jsx';
import { getOutstanding, getOffLeaseContainerDetail } from '../../api/offlease.api.js';
import { usePermission } from '../../hooks/usePermission.js';
import { exportLookupToPdf } from '../offLease/lookupExport.js';
import { uploadStageFile } from '../../services/upload.service.js';
import { useAsync } from '../../hooks/useAsync.js';
import { BASE_FIELDS, STAGE_FIELDS, cabinExpectedQty, normaliseSize, isFaultStatus, SOUND_STATUSES } from './stageFields.js';
import { stageCaption } from '../../constants/stages.js';
import { formatActionTimestamp } from '../../utils/formatDateTime.js';
import styles from './StageDetailModal.module.css';

/** Invoice numbers are spelled with different separators and case across the
 *  two systems; compared on alphanumerics alone so they still match. */
const normInvoiceNo = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/* Shared with the Billing form's own Outstanding Amount / Estimated repair
   charges billed prefill below — the Gate-In form's "Estimated repair
   budget" is free text ("INR 3000", "25K", "arround 2000/-"), not a number
   field, so a plain Number(v) only matched a handful of clean digit-only
   rows. Strip currency words/commas, expand a trailing K/k as thousands,
   then take the first number in whatever's left — genuinely non-numeric text
   (NA, No, "will know after inspection") still has no digit to find and
   stays null. */
function parseCostFigure(v) {
  let s = String(v ?? '').trim();
  if (!s) return null;
  s = s.replace(/₹|inr|rs\.?/gi, '').trim();
  const k = s.match(/^(\d+(?:\.\d+)?)\s*k$/i);
  if (k) return Number(k[1]) * 1000;
  const m = s.replace(/,/g, '').match(/\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Detail/edit form for one Off-Lease row at one stage. Fields shown are
 * exactly STAGE_FIELDS[stageNumber] (never hand-written per stage — Stage 6
 * alone has 53). Pre-filled via GET /offlease/:containerNo/stage/:stage; submits
 * only the visible field keys back to POST /offlease/:containerNo/stage/:stage.
 */
// The heading comes from stageCaption(stageNumber), so no label prop is needed.
export function StageDetailModal({ stageNumber, containerNo, rowNum, readOnly, identityOnly, movement, transport, delivery, onClose, onSaved }) {
  const { canAct } = usePermission();
  const fields = STAGE_FIELDS[stageNumber] || [];
  const { data, loading, error, reload } = useAsync(() => fetchStageDetail(containerNo, stageNumber, rowNum), [containerNo, stageNumber, rowNum]);
  const { data: leaseIdPreview } = useAsync(
    () => (stageNumber === 1 ? fetchNextLeaseId() : Promise.resolve(null)),
    [stageNumber]
  );

  const [values, setValues] = useState({});
  const [pendingFiles, setPendingFiles] = useState({});
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [reportBusy, setReportBusy] = useState(false);

  /* Stage 5 (Billing Reconciliation) "Send Back" to Stage 1 — reopens both
     stages for correction (see backend saveOffLeaseSendBackFromBilling's
     doc comment). Same capture-a-remark-first shape as the Approval desk's
     own Send Back (OffLeasePage.jsx), reusing the same modal. */
  const [sendBackOpen, setSendBackOpen] = useState(false);
  const [sendBackBusy, setSendBackBusy] = useState(false);
  const [sendBackError, setSendBackError] = useState('');
  const handleSendBackSubmit = async (remarks) => {
    setSendBackBusy(true);
    setSendBackError('');
    try {
      await submitSendBackFromBilling(containerNo, remarks, rowNum);
      setSendBackOpen(false);
      onSaved?.();
      onClose();
    } catch (e) {
      setSendBackError(apiErrorMessage(e));
    } finally {
      setSendBackBusy(false);
    }
  };

  /* Invoices for this container, from the Billing Sales sheet. Fetched only on
     the Billing stage, and scoped by Lease ID so a container off-leased twice
     resolves to this record rather than the "which one?" response. */
  const { data: billingDetail } = useAsync(
    () => (stageNumber === BILLING_STAGE && containerNo
      ? lookupContainer(containerNo, data?.col_1 || '')
      : Promise.resolve(null)),
    [stageNumber, containerNo, data?.col_1]
  );
  const billing = billingDetail?.billing?.records?.length ? billingDetail.billing : null;

  /* Tally outstanding for this container + client, from the Accounts &
     Collection app via our own proxy. Stage 1 only — the figure the
     intimation decision is made against. Removed from Billing (BILLING_STAGE)
     2026-09-23 (explicit request): that app's own login kept failing
     ("Accounts API login failed"), and the resulting error text on the
     Billing form was unwanted noise, not a useful reconciliation aid. */
  const { data: outstanding, loading: outstandingLoading } = useAsync(
    () => (stageNumber === 1 && containerNo
      ? getOutstanding(containerNo, data?.col_5 || '')
      : Promise.resolve(null)),
    [stageNumber, containerNo, data?.col_5]
  );
  /* STAGE-8/9/10 (Movement/Transport/Site Delivery) for the read-only
     Transportation stage. The Stage 2 tab's own grid batch-fetches this for
     every row up front (enrichWithStage8Movements) and passes it down via
     the movement/transport/delivery props — cheap, since it's one shared
     fetch for the whole list. Other entry points into this same modal (the
     Dashboard's order-book chips, OrderBookView.jsx) never fetched this at
     all and never passed the props, so identityOnly rows opened from there
     always rendered every FMS step as "Unavailable" regardless of whether
     the data actually existed — not a caching or backend issue, this view
     simply never wired it up. Self-fetch here whenever the caller didn't
     supply it, rather than requiring every future caller to remember to. */
  const suppliedFms = movement !== undefined || transport !== undefined || delivery !== undefined;
  const { data: ownFms, loading: fmsLoading } = useAsync(
    () => (identityOnly && !suppliedFms && containerNo
      ? getOffLeaseContainerDetail(containerNo).then((d) => d?.fms || null)
      : Promise.resolve(null)),
    [identityOnly, suppliedFms, containerNo]
  );
  const fmsMovement = suppliedFms ? movement : ownFms?.movement;
  const fmsTransport = suppliedFms ? transport : ownFms?.transport;
  const fmsDelivery = suppliedFms ? delivery : ownFms?.delivery;

  /* Report stages don't close on save — the inspector is offered the report
     for the record they just completed before the modal goes away. */
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
    if (data) setValues(data);
  }, [data]);

  /* Billing's own "Outstanding Amount" (col_306) and "Estimated repair
     charges billed" (col_308) used to start blank and make the reconciler
     retype figures the form already fetches and shows a few lines above them
     (Accounts & Collection's Net Balance, and the Cost Reference card's
     Inspection/Repair Estimate) — pre-fill each from that same source once it
     arrives, but ONLY while the cell is still genuinely blank. Never overwrite
     a value already on the sheet (someone reconciled this before and the
     figure may have been deliberately adjusted) or one the user just typed —
     functional setValues + a blank-check inside it, not a dependency on
     values itself, so this can't re-fire and clobber a fresh edit. */
  useEffect(() => {
    if (stageNumber !== BILLING_STAGE || !outstanding) return;
    const net = Number.isFinite(Number(outstanding.netBalance)) ? Number(outstanding.netBalance) : parseCostFigure(outstanding.grandTotal);
    if (net == null || !Number.isFinite(net)) return;
    setValues((prev) => (String(prev.col_306 ?? '').trim() !== '' ? prev : { ...prev, col_306: String(net) }));
  }, [stageNumber, outstanding]);

  useEffect(() => {
    if (stageNumber !== BILLING_STAGE || data?._inspectionCost == null) return;
    const est = parseCostFigure(data._inspectionCost);
    if (est == null) return;
    setValues((prev) => (String(prev.col_308 ?? '').trim() !== '' ? prev : { ...prev, col_308: String(est) }));
  }, [stageNumber, data]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  /* Lock the page behind while the modal is open. Without it the page keeps
     its own scrollbar alongside the modal's, and scrolling past the end of the
     modal silently scrolls the page underneath. The previous value is restored
     rather than assumed to be "" — another overlay may already have set it. */
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  const setField = (key, v) => setValues((prev) => ({ ...prev, [key]: v }));

  const visibleFields = useMemo(() => fields.filter((f) => !f.showIf || f.showIf(values)), [fields, values]);

  /* Fields tagged `inspection` are pulled out of the plain grid and rendered
     as the Good/Damage table instead — grouped by item, so each row can show
     its status radio plus (once Damage is picked, via the field's own showIf)
     the estimate and photo. Everything stays an ordinary field, so required-
     checks, file upload and payload building below are untouched. */
  const { plainFields, cabinFields, checklists } = useMemo(() => {
    const plain = [];
    const cabin = [];
    const groups = new Map();  // group -> Map(n -> row)
    const footers = new Map(); // group -> [field] rendered under that table
    for (const f of visibleFields) {
      if (f.cabin) { cabin.push(f); continue; }
      if (f.footerOf) {
        if (!footers.has(f.footerOf)) footers.set(f.footerOf, []);
        footers.get(f.footerOf).push(f);
        continue;
      }
      if (!f.inspection) { plain.push(f); continue; }
      const { group, n, item, role } = f.inspection;
      if (!groups.has(group)) groups.set(group, new Map());
      const byItem = groups.get(group);
      if (!byItem.has(n)) byItem.set(n, { n, item });
      byItem.get(n)[role] = f;
    }
    return {
      plainFields: plain,
      cabinFields: cabin,
      checklists: CHECKLISTS
        .filter((c) => groups.has(c.group))
        .map((c) => ({
          ...c,
          rows: [...groups.get(c.group).values()].sort((a, b) => a.n - b.n),
          footer: footers.get(c.group) || []
        }))
    };
  }, [visibleFields]);

  const busy = saving || uploading;

  /**
   * Builds the Off-Lease Container Report from the record as it stands on the
   * server. Generated on demand rather than stored, so it always reflects the
   * saved data and Billing can never open a stale copy.
   */
  const downloadReport = async () => {
    setReportBusy(true);
    setSaveError('');
    try {
      /* Pass this record's Lease ID: a container off-leased more than once has
         several records, and without it the lookup returns the "which one?"
         response — which carries no fields, so the PDF came out blank. */
      const leaseId = values.col_1 || data?.col_1 || '';
      const result = await lookupContainer(containerNo, leaseId);
      if (!result?.found) { setSaveError('Could not load this container for the report.'); return; }
      if (result.multiple) {
        setSaveError(`${containerNo} has ${result.matches.length} off-lease records and this one has no Lease ID to identify it — open it from Container Lookup and pick the client.`);
        return;
      }
      exportLookupToPdf(result);
    } catch (err) {
      setSaveError(`Could not build the report. ${apiErrorMessage(err)}`);
    } finally {
      setReportBusy(false);
    }
  };

  async function handleSubmit(e) {
    e.preventDefault();
    if (readOnly) return;
    setSaveError('');

    for (const f of visibleFields) {
      if (!f.required) continue;
      const hasValue = f.type === 'file' ? (values[f.key] || pendingFiles[f.key]) : String(values[f.key] ?? '').trim();
      if (!hasValue) {
        setSaveError(`"${f.label}" is required`);
        return;
      }
    }

    let finalValues = values;
    const fileKeys = Object.keys(pendingFiles);
    if (fileKeys.length) {
      setUploading(true);
      try {
        const uploaded = {};
        for (const key of fileKeys) uploaded[key] = await uploadStageFile(pendingFiles[key]);
        finalValues = { ...values, ...uploaded };
        setValues(finalValues);
        setPendingFiles({});
      } catch (err) {
        // Surface the server's reason — swallowing it turned a one-line Drive
        // misconfiguration into an unattributable "upload failed".
        setSaveError(`File upload failed — save aborted. ${apiErrorMessage(err)}`);
        setUploading(false);
        return;
      }
      setUploading(false);
    }

    const payload = {};
    for (const f of visibleFields) {
      // Computed fields are derived server-side (technician cost from hours) —
      // sending them would let a stale client value overwrite the derivation.
      if (f.type === 'computed') continue;
      const v = finalValues[f.key];
      if (v !== '' && v != null) payload[f.key] = v;
    }

    setSaving(true);
    try {
      const message = await submitStage(containerNo, stageNumber, payload, rowNum);
      if (message === 'ALREADY_PROCESSED') {
        setSaveError('This record was already processed by someone else — refreshing…');
        await reload();
      } else if (REPORT_STAGES.includes(stageNumber)) {
        setJustSaved(true);
      } else {
        onSaved();
      }
    } catch (err) {
      setSaveError(apiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const modalTitle = stageCaption(stageNumber);

  return (
    <div className={styles.backdrop} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={styles.modal} role="dialog" aria-modal="true" aria-label={modalTitle}>
        <div className={styles.header}>
          <h2 className={styles.title}>{modalTitle}</h2>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className={styles.body}>
          {loading && <LoadingState />}
          {!loading && error && <ErrorState message={error} onRetry={reload} />}

          {justSaved && (
            <div className={styles.savedPanel}>
              <p className={styles.savedTitle}>Stage saved</p>
              <p className={styles.savedHint}>
                {containerNo} is now complete for this stage. Download the inspection report, or close to continue.
              </p>
              {saveError && <div className={styles.error}>{saveError}</div>}
              <div className={styles.savedActions}>
                <Button type="button" variant="primary" loading={reportBusy} onClick={downloadReport}>
                  {reportBusy ? 'Building…' : 'Download Report'}
                </Button>
                <Button type="button" variant="secondary" onClick={onSaved} disabled={reportBusy}>Done</Button>
              </div>
            </div>
          )}

          {!loading && !error && !justSaved && (
            <form onSubmit={handleSubmit}>
              <div className={styles.baseGrid}>
                {BASE_FIELDS.map((f) => (
                  <div key={f.key} className={styles.baseItem}>
                    <span className={styles.baseLabel}>{f.label}</span>
                    <span className={styles.baseValue}>
                      {f.key === 'col_1' && !data?.[f.key] && leaseIdPreview
                        ? `${leaseIdPreview} (auto)`
                        : (data?.[f.key] || '—')}
                    </span>
                  </div>
                ))}
              </div>

              {/* This record was placed here directly by a Stage 2 "Move To
                  Stage" jump (either reason), not by working through the
                  normal sequence — offer a way to undo that. Independent of
                  identityOnly: Gate In has no form either way, but Inspection
                  and Billing do, and both still need this shown alongside
                  their normal fields. */}
              {!!data?._move?.canSendBackHere && (
                <SendBackPanel
                  containerNo={containerNo}
                  rowNum={rowNum}
                  moveInfo={data._move}
                  onSentBack={() => { onSaved?.(); onClose(); }}
                />
              )}

              {/* FMS movement + transport detail, matched on Container No and
                  Client Name with Movement Type = Offlease. */}
              {/* `fields` is the WHOLE matched row, labelled with that tab's
                  own headers — every column it actually filled in, not a
                  hand-picked subset. */}
              {/* The steps ARE the pipeline summary — a separate status strip
                  above them repeated the same three states twice. */}
              {identityOnly && (!suppliedFms && fmsLoading
                ? <p className={styles.fmsEmpty}>Loading FMS movement data…</p>
                : (
                  <FmsSteps
                    steps={[
                      { n: 8, label: 'Movement', record: fmsMovement, empty: 'No Offlease movement in STAGE-8 for this container and client.' },
                      { n: 9, label: 'Transport', record: fmsTransport, empty: 'No Offlease transport in STAGE-9 for this container and client.' },
                      { n: 10, label: 'Site Delivery', record: fmsDelivery, empty: "No STAGE-10 record for this container's DO number." }
                    ]}
                  />
                ))}

              {/* Alternate-disposition closeout — see saveOffLeaseMoveToStage's
                  doc comment on the backend. Reads nothing from STAGE-8/9/10
                  itself; only ever writes to this container's own Off-Lease
                  Tracking row.
                  `fmsChecked` (explicit request 2026-09-24): the form stays
                  locked until the STAGE-8 check above has actually resolved
                  (found or not) — it must never be usable before the system
                  has even looked. `fmsFound` (explicit, twice-confirmed
                  request 2026-09-24 — REVERSED from this feature's original
                  "escape hatch for containers with none" design after the
                  second confirmation): the form only UNLOCKS once STAGE-8 IS
                  found for this container; it stays locked, not even
                  submittable, while there is no STAGE-8 record yet. A
                  container with no STAGE-8 record keeps showing as "Pending"
                  in Transportation (with an explicit "Stage 8 Fetch Pending"
                  label — see FmsDots in StagePageBase.jsx) until one lands.
                  Enforced again server-side in saveOffLeaseMoveToStage/Fast,
                  not just here — this UI gate is a convenience, not the real
                  check. */}
              {identityOnly && (
                <MoveToStageSection
                  containerNo={containerNo}
                  rowNum={rowNum}
                  canMove={canAct(`offlease${stageNumber}`)}
                  fmsChecked={suppliedFms || !fmsLoading}
                  fmsFound={!!fmsMovement}
                  alreadyMoved={data?._move}
                  onMoved={() => { onSaved?.(); onClose(); }}
                />
              )}

              {stageNumber === 1 && (
                <OutstandingPanel data={outstanding} loading={outstandingLoading} />
              )}

              {stageNumber === BILLING_STAGE && (
                <>
                  <CostReferencePanel inspectionCost={data?._inspectionCost} />
                  <TransportInvoiceNote invoice={data?._transportInvoice} />
                  <InspectionReferenceTable title="Container Inspection Checklist" points={data?._inspectionPoints} />
                  <InspectionReferenceTable title="Machine Check" points={data?._machinePoints} />
                  <Stage1DataNote data={data?._stage1Data} />
                </>
              )}

              {stageNumber === FMS_CLOSURE_STAGE && <Stage5ReferenceNote data={data} />}

              {/* Gate In's own form was removed 2026-08-24: gate/depot staff
                  already fill out a separate Google Form for every container
                  movement, and the app now reads that directly (Status +
                  Repair Required, matched by container) instead of asking
                  for the same information twice. A container still sitting
                  here has not shown up as "Inward (Gate-In)" on that form
                  yet — there is nothing to save in the app itself. Suppressed
                  when the record arrived via a Move To Stage jump instead —
                  SendBackPanel above already explains why it's here. */}
              {!identityOnly && !fields.length && !data?._move?.canSendBackHere && (
                <div className={styles.savedPanel}>
                  <p className={styles.savedTitle}>Waiting for Gate-In confirmation</p>
                  <p className={styles.savedHint}>
                    This container moves on automatically once the Gate Entry Google Form
                    (filled out by gate/depot staff) shows it as "Inward (Gate-In)" — usually
                    within a few minutes. Nothing to fill in here.
                  </p>
                </div>
              )}

              {billing && <BillingTable billing={billing} clientName={data?.col_5} />}

              {/* identityOnly: the container's own details and nothing else.
                  Stage 2 is a read-only master list, so opening a row is for
                  looking up who and what the container is — its stage fields
                  are not part of that. */}
              {/* Fields carrying a `group` are rendered in labelled sections;
                  ungrouped stages keep the single flat grid they had. */}
              {!identityOnly && !data?._skipped && plainFields.some((f) => f.group) && (
                <FormSections
                  fields={plainFields}
                  values={values}
                  pendingFiles={pendingFiles}
                  disabled={readOnly || busy}
                  onChange={setField}
                  onFile={(key, payload) => { setPendingFiles((p) => ({ ...p, [key]: payload })); setField(key, payload.fileName); }}
                />
              )}

              {!identityOnly && !data?._skipped && !plainFields.some((f) => f.group) && (
              <div className={styles.fieldGrid}>
                {plainFields.map((f) => (
                  <Field
                    key={f.key}
                    field={f}
                    value={values[f.key]}
                    pendingFileName={pendingFiles[f.key]?.fileName}
                    onChange={(v) => setField(f.key, v)}
                    onFile={(payload) => { setPendingFiles((p) => ({ ...p, [f.key]: payload })); setField(f.key, payload.fileName); }}
                    disabled={readOnly || busy}
                  />
                ))}
              </div>
              )}

              {!identityOnly && !data?._skipped && checklists.map((c) => (
                <ChecklistTable
                  key={c.group}
                  title={c.title}
                  columnLabel={c.columnLabel}
                  rows={c.rows}
                  footer={c.footer}
                  values={values}
                  pendingFiles={pendingFiles}
                  disabled={readOnly || busy}
                  onChange={setField}
                  onFile={(key, payload) => { setPendingFiles((p) => ({ ...p, [key]: payload })); setField(key, payload.fileName); }}
                />
              ))}

              {!identityOnly && !data?._skipped && cabinFields.length > 0 && (
                <CabinTable
                  fields={cabinFields}
                  size={data?.col_2}
                  values={values}
                  disabled={readOnly || busy}
                  onChange={setField}
                />
              )}

              {/* Commentary scoped to THIS stage — distinct from the
                  dashboard's own record-wide thread (OrderBookView's
                  RemarkCell). Shown even for identityOnly/read-only stages
                  (Gate In has no form fields at all, but a remark is still
                  useful there) — remarking is a separate concern from
                  editing the stage's own data. */}
              {!identityOnly && containerNo && (
                <StageRemarks containerNo={containerNo} leaseId={data?.col_1} stageNumber={stageNumber} />
              )}

              {saveError && <div className={styles.error}>{saveError}</div>}

              <div className={styles.actions}>
                {REPORT_STAGES.includes(stageNumber) && (
                  <Button
                    type="button"
                    variant="secondary"
                    className={styles.reportBtn}
                    loading={reportBusy}
                    disabled={busy}
                    onClick={downloadReport}
                  >
                    {reportBusy ? 'Building…' : 'Download Report'}
                  </Button>
                )}
                <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
                  {readOnly ? 'Close' : 'Cancel'}
                </Button>
                {!readOnly && stageNumber === BILLING_STAGE && !data?._skipped && canAct('offlease5') && (
                  <Button type="button" variant="secondary" disabled={busy} onClick={() => setSendBackOpen(true)}>
                    Send Back to Stage 1
                  </Button>
                )}
                {!readOnly && fields.length > 0 && !data?._skipped && (
                  <Button type="submit" variant="primary" loading={busy}>
                    {uploading ? 'Uploading files…' : saving ? 'Saving…' : 'Save Stage'}
                  </Button>
                )}
              </div>
            </form>
          )}
        </div>
      </div>

      {/* Outside the form above — RejectModal renders its own <form>, and
          nesting forms is invalid HTML / unpredictable across browsers. */}
      <RejectModal
        open={sendBackOpen}
        item={{ row: [containerNo] }}
        submitting={sendBackBusy}
        error={sendBackError}
        onClose={() => { setSendBackOpen(false); setSendBackError(''); }}
        onSubmit={handleSendBackSubmit}
        titleWord="Send Back"
        titleSubject="to Stage 1"
        placeholder="What needs fixing before this can be resubmitted? (optional)"
        submitLabel="Send Back"
        variant="secondary"
      />
    </div>
  );
}

/* Order the damage detail fields appear in, and the short label each gets
   inside the table (the field's own label carries the item name too, which
   would be redundant once it is nested under that item's row). */
const DAMAGE_ROLES = [
  ['estimate', 'Estimate Value'],
  ['photo', 'Photo'],
  ['remark', 'Remarks']
];

/**
 * Stages that offer the inspection report: Stage 3 captures it, and Final
 * Billing (internally stage 5, shown as Stage 6) needs to read it before
 * invoicing. These are INTERNAL stage numbers.
 */
const REPORT_STAGES = [3, 5];

/** Final Billing (internally stage 5, shown as Stage 5) — the person
 *  reconciling needs the container's actual invoices in front of them. */
const BILLING_STAGE = 5;

/** KAM (internally stage 8, shown as Stage 6) — see Stage5ReferenceNote. */
const FMS_CLOSURE_STAGE = 8;

/** Colour for a chosen status: red for any fault, green for Good/OK, grey for
 *  Not Required, nothing while unset. */
function statusTone(status, styles) {
  if (!status) return '';
  if (isFaultStatus(status)) return styles.statusDamage;
  if (SOUND_STATUSES.includes(status.toLowerCase())) return styles.statusGood;
  return styles.statusNA;
}

/* The checklist tables Stage 3 renders, in display order. A group only
   appears if STAGE_FIELDS actually defines fields tagged with it. */
const CHECKLISTS = [
  { group: 'inspection', title: 'Container Inspection Checklist', columnLabel: 'Instruction Points' },
  { group: 'machine', title: 'Machine Check', columnLabel: 'Machine Points' }
];

/**
 * One checklist table — a row per point with a Good/Damage choice, mirroring
 * the printed sheet. Picking Damage reveals that point's own Estimate Value,
 * Photo and Remarks directly beneath it (those fields carry a showIf, so they
 * are simply absent until then).
 */
/**
 * Read-only table of the container's invoices from the Billing Sales sheet,
 * shown on Billing Reconciliation so the figures being reconciled are visible
 * in the form. Not editable here — Billing Sales is that sheet's own record.
 */
/**
 * Tally outstanding for this container and client, from the Accounts &
 * Collection app. Shown on Stage 1 so the intimation is raised with the
 * client's exposure in view. Read-only — that app owns the figures.
 */
function OutstandingPanel({ data, loading }) {
  const inr = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : '—';
  };

  if (loading) return <p className={styles.sectionHint}>Loading outstanding…</p>;
  if (!data) return null;

  /* Invoice number -> its file on the Billing Sales sheet. Re-keyed on
     alphanumerics only, so separator and case differences between the two
     systems ("QUA/APR65/26-27" vs "QUA-APR65-26-27") still line up. */
  const invoiceFiles = {};
  for (const [no, link] of Object.entries(data.invoiceAttachments || {})) {
    if (no && link) invoiceFiles[normInvoiceNo(no)] = link;
  }

  /* Each invoice's OWN document. `invoiceUrl` comes from the Accounts &
     Collection ledger, which holds one distinct file per invoice number — the
     same ↗ their modal shows. The Billing Sales join is the fallback for
     invoices only that sheet carries. Never another invoice's file: an invoice
     with no document renders as "No file" and stays in the table. */
  const fileFor = (i) => i.invoiceUrl || invoiceFiles[normInvoiceNo(i.invoiceNo)] || '';

  /* The API is the only source. An empty response says so plainly rather than
     falling back to any other data — there is no sheet fallback by design. */
  if (!data.invoiceTotals?.length) {
    return (
      <>
        <h3 className={styles.sectionTitle}>Outstanding (Accounts &amp; Collection)</h3>
        <p className={styles.sectionHint}>
          {data.error
            ? `Could not reach Accounts & Collection — ${data.error}`
            : 'No invoices found.'}
        </p>
      </>
    );
  }

  return (
    <>
      <h3 className={styles.sectionTitle}>Outstanding (Accounts &amp; Collection)</h3>
      <p className={styles.sectionHint}>
        {data.matchedParty ? `Tally party: ${data.matchedParty}` : 'No matching Tally party'}
        {data.error ? ` · ${data.error}` : ''}
      </p>

      {/* Only the invoice-wise grand total is carded — the client-level Tally
          figure and the repeated "open" total were removed as redundant with
          the table's own Grand Total row. */}
      <div className={styles.outstandingRow}>
        <div className={styles.outstandingCard}>
          <span className={styles.outstandingLabel}>
            Grand Total{data.invoiceCount ? ` (${data.invoiceCount} invoice${data.invoiceCount === 1 ? '' : 's'})` : ''}
          </span>
          <span className={styles.outstandingValue}>{inr(data.grandTotal)}</span>
        </div>
      </div>

      {/* One row per INVOICE. Containers stack inside a single cell — every one
          listed in full, but without turning each into its own table row. */}
      {data.invoiceTotals?.length > 0 && (
        <table className={styles.invTable}>
          <colgroup>
            <col className={styles.colInvoice} />
            <col className={styles.colContainers} />
            <col className={styles.colMonth} />
            <col className={styles.colAmount} />
            <col className={styles.colAge} />
            <col className={styles.colAttachment} />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">Invoice No.</th>
              <th scope="col">Container No(s).</th>
              <th scope="col" className={styles.tCenter}>Month</th>
              <th scope="col" className={styles.tRight}>Total Amount</th>
              <th scope="col" className={styles.tCenter}>Age</th>
              <th scope="col" className={styles.tCenter}>Invoice</th>
            </tr>
          </thead>
          <tbody>
            {data.invoiceTotals.map((i, k) => (
              <tr key={`${i.invoiceNo}-${k}`}>
                {/* Invoice number opens its PDF, matching the ↗ in Accounts &
                    Collection. Plain text when no file is on the sheet — a
                    link that goes nowhere is worse than no link. */}
                <td className={styles.invNo}>
                  {fileFor(i)
                    ? (
                      <a
                        className={styles.invLink}
                        href={fileFor(i)}
                        target="_blank"
                        rel="noreferrer"
                        title={`Open ${i.invoiceNo}`}
                      >
                        <span>{i.invoiceNo}</span>
                        <Icon name="external" className={styles.invLinkIcon} />
                      </a>
                    )
                    : (i.invoiceNo || '—')}
                </td>
                <td>
                  {i.containers?.length
                    ? (
                      <ul className={styles.cnList}>
                        {i.containers.map((cn) => <li key={cn}>{cn}</li>)}
                      </ul>
                    )
                    : '—'}
                </td>
                <td className={styles.tCenter}>{i.period || '—'}</td>
                <td className={styles.tRight}>{inr(i.amount)}</td>
                <td className={styles.tCenter}>{i.overdueDays ? `${i.overdueDays}d` : '—'}</td>
                {/* That invoice's own document. Disabled marker, not a hidden
                    row, when the invoice genuinely has no file. */}
                <td className={styles.tCenter}>
                  {fileFor(i)
                    ? (
                      <a
                        className={styles.invFileBtn}
                        href={fileFor(i)}
                        target="_blank"
                        rel="noreferrer"
                        title={`Open invoice ${i.invoiceNo}`}
                        aria-label={`Open invoice ${i.invoiceNo}`}
                      >
                        <Icon name="external" />
                      </a>
                    )
                    : <span className={styles.invNoFile} title="No invoice file">No file</span>}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={3}>Grand Total</td>
              <td className={styles.tRight}>{inr(data.grandTotal)}</td>
              <td colSpan={2} />
            </tr>
          </tfoot>
        </table>
      )}

      {/* CLIENT-WIDE position. The table above is invoice-wise; this is the
          party's full DR / CR balance, matching the Accounts & Collection
          modal's summary strip. Receipts explain why the open figure differs
          from the net. */}
      {(data.totalDr > 0 || data.totalCr > 0) && (
        <div className={styles.drCrRow}>
          <div className={styles.drCrItem}>
            <span className={styles.drCrLabel}>Total DR</span>
            <span className={`${styles.drCrValue} ${styles.drCrDebit}`}>{inr(data.totalDr)}</span>
          </div>
          <div className={styles.drCrItem}>
            <span className={styles.drCrLabel}>Total CR</span>
            <span className={`${styles.drCrValue} ${styles.drCrCredit}`}>{inr(data.totalCr)}</span>
          </div>
          <div className={styles.drCrItem}>
            <span className={styles.drCrLabel}>Net Balance</span>
            <span className={styles.drCrValue}>{inr(data.netBalance)}</span>
          </div>
          {data.receipts?.length > 0 && (
            <div className={styles.drCrItem}>
              <span className={styles.drCrLabel}>Receipts</span>
              <span className={styles.drCrValue}>
                {data.receipts.map((r) => `${r.ref} ${inr(r.amount)}`).join(' · ')}
              </span>
            </div>
          )}
        </div>
      )}
    </>
  );
}

/**
 * Reference-only figure for whoever is reconciling billing: the Inspection
 * Checklist's own Estimate Value total (falling back to the Gate-In form's
 * repair estimate if the checklist has none), fetched server-side
 * (getStageDetail, offlease.controller.js) so the person filling this form
 * doesn't have to go find it on another screen. Never written anywhere —
 * this is a lookup aid, not a form field, same relationship OutstandingPanel
 * has to Stage 1's intimation decision. Transport Cost (Stage 9 Freight)
 * removed from here 2026-09-18 (explicit request).
 */
function CostReferencePanel({ inspectionCost }) {
  const i = parseCostFigure(inspectionCost);
  const inr = (n) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

  return (
    <>
      <h3 className={styles.sectionTitle}>Cost Reference (Inspection)</h3>
      <p className={styles.sectionHint}>
        Fetched from the Inspection Checklist's own Estimate Value total (falling
        back to the Gate-In form's repair estimate if the checklist has none) — for
        reference while reconciling, not saved anywhere on this form.
      </p>
      <div className={styles.outstandingRow}>
        <div className={styles.outstandingCard}>
          <span className={styles.outstandingLabel}>Inspection / Repair Estimate</span>
          {/* No usable figure (blank cell, "NA", or no checklist/Gate-In data
              at all) reads as "no repair cost", not "unknown" — shown as ₹0,
              not "—". Explicit request 2026-09-08. */}
          <span className={styles.outstandingValue}>{inr(i ?? 0)}</span>
        </div>
      </div>
    </>
  );
}

/**
 * Accounts' vetted Transportation Invoice ("Invoice PO" sheet, mirrored into
 * Mongo), matched by DO Number to this container's STAGE-8/9 shipment — see
 * stage8.service.js's getInvoicePoForContainer. Explicit request 2026-09-23:
 * the reconciler wants to open the actual invoice file from here instead of
 * going to that sheet directly.
 *
 * Gated on invoice.invoiceUrl specifically (not just a DO match existing) —
 * CHANGED 2026-09-23 (explicit request, "all show NA"): most DO matches at
 * this point are still "Pending" with every other field genuinely blank
 * (Accounts hasn't vetted them yet), so showing the card for those was a
 * near-empty wall of dashes on almost every container, not a useful
 * reference. Only worth showing once there's an actual file to open.
 */
function TransportInvoiceNote({ invoice }) {
  if (!invoice?.invoiceUrl) return null;
  return (
    <>
      <h3 className={styles.sectionTitle}>Transportation Invoice (Invoice PO)</h3>
      <p className={styles.sectionHint}>
        Matched by DO Number against Accounts' Invoice PO log — for reference while
        reconciling, not saved anywhere on this form.
      </p>
      <div className={styles.outstandingRow}>
        <div className={styles.outstandingCard}>
          <span className={styles.outstandingLabel}>Status</span>
          <span className={styles.outstandingValue}>{invoice.status || '—'}</span>
        </div>
        <div className={styles.outstandingCard}>
          <span className={styles.outstandingLabel}>Vetted Amount</span>
          <span className={styles.outstandingValue}>{renderCellValue(invoice.vettedAmount)}</span>
        </div>
        <div className={styles.outstandingCard}>
          <span className={styles.outstandingLabel}>Invoice File</span>
          <span className={styles.outstandingValue}>{renderCellValue(invoice.invoiceUrl)}</span>
        </div>
        <div className={styles.outstandingCard}>
          <span className={styles.outstandingLabel}>Confirmed By</span>
          <span className={styles.outstandingValue}>{invoice.confirmedBy || '—'}</span>
        </div>
        <div className={styles.outstandingCard}>
          <span className={styles.outstandingLabel}>Bill No</span>
          <span className={styles.outstandingValue}>{invoice.billNo || '—'}</span>
        </div>
      </div>
    </>
  );
}

/**
 * Full Stage 4 Inspection Checklist + Machine Check, read-only, for whoever
 * is reconciling Final Billing — explicit request 2026-09-18: the Cost
 * Reference total above wasn't enough, they want every point visible here
 * too instead of having to reopen Stage 4. Same point shape (and the same
 * "collapse Estimate/Photo/Remarks unless something's actually damaged"
 * rule) as LookupResult.jsx's own read-only ChecklistTable — see
 * getOffLeaseStageDetail's _inspectionPoints/_machinePoints for the fetch.
 */
function InspectionReferenceTable({ title, points }) {
  if (!points?.length) return null;
  const anyDamage = points.some((p) => isFaultStatus(p.status));
  return (
    <div className={styles.inspWrap}>
      <p className={styles.sectionHint}>{title}</p>
      <table className={styles.inspTable}>
        <thead>
          <tr>
            <th>Point</th>
            <th>Good / Damage</th>
            {anyDamage && <><th>Estimate</th><th>Photo</th><th>Remarks</th></>}
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.n}>
              <td><span className={styles.inspNum}>{p.n}.</span>{p.item}</td>
              <td><span className={statusTone(p.status, styles)}>{p.status || '—'}</span></td>
              {anyDamage && (
                <>
                  <td>{p.estimate || '—'}</td>
                  <td>{p.photo ? renderCellValue(p.photo) : '—'}</td>
                  <td>{p.remark || '—'}</td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Stage 1's own intimation dates, fetched read-only for the reconciler —
 * Final Billing Date in particular is the figure Billing is meant to
 * reconcile against, set back at intimation time and otherwise invisible on
 * this form (getOffLeaseStageDetail's _stage1Data); never saved from here.
 */
function Stage1DataNote({ data }) {
  if (!data || (!data.intimationDate && !data.offLeaseDate && !data.finalBillingDate && !data.emailNotification)) return null;
  return (
    <div className={styles.outstandingRow}>
      <div className={styles.outstandingCard}>
        <span className={styles.outstandingLabel}>Off-Lease Intimation Date (Stage 1)</span>
        <span className={styles.outstandingValue}>{data.intimationDate || '—'}</span>
      </div>
      <div className={styles.outstandingCard}>
        <span className={styles.outstandingLabel}>Off-Lease Date (Stage 1)</span>
        <span className={styles.outstandingValue}>{data.offLeaseDate || '—'}</span>
      </div>
      <div className={styles.outstandingCard}>
        <span className={styles.outstandingLabel}>Final Billing Date (Stage 1)</span>
        <span className={styles.outstandingValue}>{data.finalBillingDate || '—'}</span>
      </div>
      <div className={styles.outstandingCard}>
        <span className={styles.outstandingLabel}>Email Notification (Stage 1)</span>
        <span className={styles.outstandingValue}>{renderCellValue(data.emailNotification)}</span>
      </div>
    </div>
  );
}

/** Stage 5's own field labels (stageFields.js), paired with the _stage5Data
 *  key each one reads from — kept as one list so Stage5ReferenceNote and
 *  its data source can't quietly drift apart. */
const STAGE5_REFERENCE_FIELDS = [
  ['rentalsBilledTillDate', 'Rentals Billed Up To Last Date'],
  ['outstandingAmount', 'Outstanding Amount'],
  ['dateBilledTill', 'Date - Billed Till'],
  ['repairChargesBilled', 'Estimated Repair Charges Billed'],
  ['transportCostBilled', 'Transport Cost Billed'],
  ['adjustSecurityDeposit', 'Adjust Security Deposit'],
  ['securityDepositAmount', 'Security Deposit Amount'],
  ['reconcileEntireCycle', 'Reconcile Entire Billing Cycle'],
  ['remark', 'Remark']
];

/**
 * Read-only reference for Stage 6 (KAM) — every field on Stage 5's (Final
 * Billing) own form, shown alongside Stage 6's own Payment Confirmation
 * questions (stageFields.js, col_326-329) so KAM can see what Final Billing
 * reconciled while confirming what was actually paid. Editing these stays
 * on Stage 5's own form; this is reference only.
 */
function Stage5ReferenceNote({ data }) {
  const s5 = data?._stage5Data;
  if (!s5 || !String(s5.status || '').trim()) return null; // Stage 5/Final Billing hasn't run yet — nothing to show
  return (
    <>
      <h3 className={styles.sectionTitle}>Final Billing (Stage 6)</h3>
      <p className={styles.sectionHint}>Answered on Stage 6's own form — reference only, not editable here.</p>
      <div className={styles.outstandingRow}>
        {STAGE5_REFERENCE_FIELDS.map(([key, label]) => (
          <div className={styles.outstandingCard} key={key}>
            <span className={styles.outstandingLabel}>{label}</span>
            <span className={styles.outstandingValue}>{renderCellValue(s5[key])}</span>
          </div>
        ))}
      </div>
    </>
  );
}

/**
 * A labelled block of read-only values from one of the FMS tabs. Renders
 * nothing at all when that tab was not consulted for this stage, and an
 * explicit note when it was consulted but found no match — "no row matched" is
 * information, whereas a silently absent section reads as an oversight.
 */
/**
 * Field groups for the FMS panels.
 *
 * These sheets are 30-80 columns of mixed concerns — references, route,
 * vehicle, money, documents, approvals — and a flat list of them reads as
 * noise however it is styled. Grouping is what makes the panel scannable:
 * a reader looking for the LR number goes to Vehicle & Driver rather than
 * sweeping every field.
 *
 * Matched on the label text because the three tabs name their columns
 * differently and by position would break the moment a column moved. First
 * matching group wins, so ORDER MATTERS here — "Delivery Order Number" is a
 * reference, not a route field, so Reference is tested first.
 */
const FMS_GROUPS = [
  { title: 'Reference', tone: 'navy', re: /quotation|order (received )?number|booking order|do number|delivery order|cleaned_do|timestamp|^user$|email/i },
  { title: 'Client & Container', tone: 'info', re: /client|customer|container|size|type|movement|wt\b|quantity/i },
  { title: 'Route', tone: 'teal', re: /city|address|pin ?code|yard|location|destination|pickup|pick-up|delivery(?! order)/i },
  { title: 'Vehicle & Driver', tone: 'violet', re: /vehicle|truck|driver|lr |lr no|transporter|person|mobile|pan|licence|license|rc book/i },
  { title: 'Dates & Transit', tone: 'amber', re: /date|transit|days/i },
  { title: 'Charges', tone: 'success', re: /cost|amount|charge|freight|advance|balance|payment|memo|km\b|bill/i },
  { title: 'Documents & Photos', tone: 'slate', re: /photo|video|copy|scan|attachment|file|interchange|sign/i },
  { title: 'Approval', tone: 'warn', re: /^_|approver|status|remark|followup/i }
];

/** Splits a record's fields into the groups above, preserving sheet order
 *  inside each. Empty groups are dropped, and anything unmatched collects
 *  under "Other" rather than being silently hidden. */
function groupFields(fields) {
  const buckets = new Map(FMS_GROUPS.map((g) => [g.title, []]));
  const other = [];

  for (const pair of fields) {
    const g = FMS_GROUPS.find((x) => x.re.test(pair[0]));
    (g ? buckets.get(g.title) : other).push(pair);
  }

  const out = FMS_GROUPS
    .map((g) => ({ title: g.title, tone: g.tone, items: buckets.get(g.title) }))
    .filter((g) => g.items.length);
  if (other.length) out.push({ title: 'Other', tone: 'slate', items: other });
  return out;
}

/**
 * Spreads the groups across `n` columns, always adding the next group to the
 * SHORTEST column so far.
 *
 * Neither CSS approach worked here. A grid sizes every row to its tallest tile,
 * leaving dead space under the short ones. Multi-column balances to a single
 * computed height and stops once the content fits, which left the right-hand
 * columns completely empty. Distributing explicitly fills every column and
 * leaves no gaps.
 *
 * Height is estimated from the field count plus a constant for the header —
 * close enough to balance, and it needs no DOM measurement or re-layout.
 */
function balanceIntoColumns(groups, n) {
  const cols = Array.from({ length: n }, () => []);
  const heights = new Array(n).fill(0);

  for (const g of groups) {
    const shortest = heights.indexOf(Math.min(...heights));
    cols[shortest].push(g);
    heights[shortest] += g.items.length + 2;   // +2 ≈ header and card padding
  }
  return cols.filter((c) => c.length);          // drop unused columns entirely
}

/**
 * One group as a collapsible bento tile.
 *
 * Open by default — collapsing is for putting a group you have finished with
 * out of the way, not for hiding data behind a click the first time you look.
 * Tiles flow in a masonry column layout, so each takes only its own height and
 * no size hint is needed.
 */
function FmsGroupCard({ group }) {
  const [open, setOpen] = useState(true);

  return (
    <section className={`${styles.fmsGroup} ${styles[`tone_${group.tone}`]}`}>
      <button
        type="button"
        className={styles.fmsGroupTitle}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {/* A real control, not a text glyph: a boxed chevron that ROTATES on
            toggle is what makes a card read as an accordion. */}
        <span className={`${styles.fmsChevron} ${open ? styles.fmsChevronOpen : ''}`} aria-hidden="true">
          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 9.5l6 6 6-6" />
          </svg>
        </span>
        {group.title}
        <span className={styles.fmsGroupCount}>{group.items.length}</span>
      </button>

      {open && (
        <div className={styles.fmsFields}>
          {group.items.map(([label, value]) => (
            <div key={label} className={styles.fmsItem}>
              <span className={styles.fmsLabel}>{label}</span>
              <span className={styles.fmsValue}>{renderCellValue(value)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * A stage form split into labelled sections, one per field `group`.
 *
 * Twenty fields in a single grid — nine of them near-identical "Choose file"
 * links — meant reading the whole form to find one input. Sections turn that
 * into four short, self-describing blocks, so the reader only looks at the one
 * they need.
 *
 * Group order follows the field order in stageFields.js; the same reason the
 * FMS panel keeps sheet order rather than sorting.
 */
function FormSections({ fields, values, pendingFiles, disabled, onChange, onFile }) {
  const sections = [];
  for (const f of fields) {
    const title = f.group || '';
    const last = sections[sections.length - 1];
    if (last && last.title === title) last.items.push(f);
    else sections.push({ title, items: [f] });
  }

  return (
    <div className={styles.formSections}>
      {sections.map((s) => (
        <section key={s.title} className={styles.formSection}>
          {s.title && <h4 className={styles.formSectionTitle}>{s.title}</h4>}
          <div className={styles.fieldGrid}>
            {s.items.map((f) => (
              <Field
                key={f.key}
                field={f}
                value={values[f.key]}
                pendingFileName={pendingFiles[f.key]?.fileName}
                onChange={(v) => onChange(f.key, v)}
                onFile={(payload) => onFile(f.key, payload)}
                disabled={disabled}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/** undefined = sheet unreadable; null = read but no match; object = found.
 *  Three different facts — a failed read must never read as "no record". */
const fmsState = (record) => (record === undefined ? 'unread' : record?.fields?.length ? 'found' : 'missing');
const FMS_STATE_TEXT = { found: 'Fetched', missing: 'No record', unread: 'Unavailable' };

/**
 * STAGE-8 -> 9 -> 10 as clickable steps, with only the selected step's detail
 * shown.
 *
 * Three columns side by side still scrolled: STAGE-9 alone returns 66 fields.
 * One step at a time, in a grid that flows into columns, fits the detail in
 * the modal without any vertical scrolling.
 */
function FmsSteps({ steps }) {
  /* Opens on the first step that actually has data — landing on an empty
     STAGE-8 would hide the two populated ones behind a click. */
  const firstWithData = steps.find((s) => fmsState(s.record) === 'found')?.n ?? steps[0].n;
  const [active, setActive] = useState(firstWithData);
  const step = steps.find((s) => s.n === active) || steps[0];
  const state = fmsState(step.record);

  return (
    <div className={styles.fmsWrap}>
      <div className={styles.stepRow} role="tablist">
        {steps.map((s, i) => {
          const st = fmsState(s.record);
          return (
            <Fragment key={s.n}>
              {i > 0 && <span className={styles.stepLine} aria-hidden="true" />}
              <button
                type="button"
                role="tab"
                aria-selected={s.n === active}
                className={`${styles.step} ${styles[`step_${st}`]} ${s.n === active ? styles.stepActive : ''}`}
                onClick={() => setActive(s.n)}
              >
                <span className={styles.stepNum}>{s.n}</span>
                <span className={styles.stepLabel}>{s.label}</span>
                <span className={styles.stepState}>{FMS_STATE_TEXT[st]}</span>
              </button>
            </Fragment>
          );
        })}
      </div>

      {state === 'found'
        ? (
          /* Grouped into sections, each flowing into columns. Sheet order is
             kept WITHIN a group, so related fields stay adjacent as they are
             on the sheet. */
          <div className={styles.fmsGroups}>
            {balanceIntoColumns(groupFields(step.record.fields), 3).map((col, i) => (
              <div className={styles.fmsCol} key={i}>
                {col.map((g) => <FmsGroupCard key={g.title} group={g} />)}
              </div>
            ))}
          </div>
        )
        : (
          <p className={styles.fmsEmpty}>
            {state === 'unread'
              ? 'Sheet could not be read — Google Sheets read quota exhausted.'
              : step.empty}
          </p>
        )}
    </div>
  );
}

const MOVE_REASON_OPTIONS = ['Client to Client', 'Client Scope', 'Other'];

/** Display stage number (submitted to the backend) -> friendly label. Only
 *  Gate In / Inspection / Final Billing are valid direct-jump destinations
 *  from Stage 2 — see OL_JUMP_TARGET_INTERNALS on the backend. Values
 *  updated 2026-09-18 (explicit request) to match the renumbering — must
 *  stay in step with OL_STAGE_DISPLAY there. */
/* BUG FOUND AND FIXED 2026-09-24: these values are submitted as a DISPLAY
   stage number, resolved back to an internal stage on the backend via
   OL_INTERNAL_BY_DISPLAY.get(display) — they must always match the CURRENT
   live numbering (constants/stages.js's WORKFLOW / offlease.service.js's
   OL_ACTIVE_STAGE_NUMS), not be hand-duplicated once and left behind. This
   array was never updated when internal Stage 10 ("LR & Return
   Transportation") was removed 2026-09-22, which shifted Gate In/Inspection/
   Final Billing's own display numbers back down by one — so choosing
   "Stage 5 – Inspection Checklist" here was silently submitting moveToStage
   = "5", which the backend now resolves to Final Billing (today's real
   Stage 5), not Inspection. Confirmed harmless for every jump recorded
   BEFORE 2026-09-22 (those genuinely used the old numbering), but a live
   landmine for any jump made after it and before this fix. */
const MOVE_JUMP_TARGET_OPTIONS = [
  { value: '3', label: 'Stage 3 – Gate In' },
  { value: '4', label: 'Stage 4 – Inspection Checklist' },
  { value: '5', label: 'Stage 5 – Final Billing' }
];

/**
 * Stage 2 (Transportation) "Move To Stage" — a manual alternate-disposition
 * move for containers that never go through the FMS-tracked transport chain
 * (STAGE-8/9/10) at all: a direct client-to-client transfer, or some other
 * movement type with nothing for the FMS panel above to ever match.
 *
 * All three reasons record a Lifting Date and a direct Move To Stage
 * destination (Stage 3/4/5), and the record appears there immediately,
 * skipping whatever normally sits in between — see saveOffLeaseMoveToStage's
 * doc comment on the backend. That destination stage then offers Send Back
 * (SendBackPanel below) to undo it.
 *
 * Reason = "Client to Client" additionally captures a New Client Name.
 * Reason = "Client Scope" additionally captures a free-text Scope. Reason =
 * "Other" additionally captures a free-text Comment / Type.
 *
 * `fmsChecked` (explicit request 2026-09-24): stays false while the STAGE-8
 * check above is still loading, locking the whole form until it resolves —
 * whether or not a STAGE-8 record actually exists for this container.
 * `fmsFound` (explicit, twice-confirmed request 2026-09-24): once checked,
 * the form stays locked UNTIL a STAGE-8 record IS found for this container —
 * not the other way around. This is a deliberate reversal of the feature's
 * original "escape hatch for containers with none" framing (raised once as
 * a conflict and re-confirmed by the user in plain terms), so a container
 * only becomes movable here once its STAGE-8 movement is actually on file.
 * Enforced again server-side (saveOffLeaseMoveToStage/Fast) — this is a
 * convenience gate, not the authoritative check. A container with no
 * STAGE-8 record yet keeps showing as "Pending" in Transportation (with an
 * explicit "Stage 8 Fetch Pending" label — FmsDots in StagePageBase.jsx)
 * until this unlocks.
 */
function MoveToStageSection({ containerNo, rowNum, canMove, fmsChecked, fmsFound, alreadyMoved, onMoved }) {
  const [reason, setReason] = useState('');
  const [newClientName, setNewClientName] = useState('');
  const [clientScope, setClientScope] = useState('');
  const [commentType, setCommentType] = useState('');
  const [remarks, setRemarks] = useState('');
  const [date, setDate] = useState('');
  const [moveToStage, setMoveToStage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(null); // { reason, label } once moved

  // Already recorded (this modal was reopened after a Move) — show what was
  // saved instead of an editable form; there's nothing left to submit here,
  // Send Back (on the destination stage) is the only way to change it now.
  if (alreadyMoved?.active) {
    const target = MOVE_JUMP_TARGET_OPTIONS.find((o) => Number(o.value) === alreadyMoved.jumpTargetDisplay);
    return (
      <div className={styles.fmsWrap}>
        <h3 className={styles.sectionTitle}>Move To Stage</h3>
        <p className={styles.sectionHint}>
          Reason: {alreadyMoved.reason}
          {alreadyMoved.newClientName ? ` — New Client: ${alreadyMoved.newClientName}` : ''}
          {alreadyMoved.clientScope ? ` (${alreadyMoved.clientScope})` : ''}
          {alreadyMoved.commentType ? ` — ${alreadyMoved.commentType}` : ''}
          {alreadyMoved.date ? ` · Lifting ${alreadyMoved.date}` : ''}
          {alreadyMoved.remarks ? ` · ${alreadyMoved.remarks}` : ''}
          {target ? ` · Moved to ${target.label}` : ''}
        </p>
      </div>
    );
  }

  const handleMove = async () => {
    if (!reason) { setError('Select a Reason first.'); return; }
    setError('');

    if (!date) { setError('Date is required.'); return; }
    if (!moveToStage) { setError('Select a Move To Stage destination.'); return; }

    const payload = { reason, remarks: remarks.trim(), date, moveToStage, rowNum };
    const target = MOVE_JUMP_TARGET_OPTIONS.find((o) => o.value === moveToStage);
    const destLabel = target?.label || `Stage ${moveToStage}`;
    let successLabel = '';
    if (reason === 'Client to Client') {
      const name = newClientName.trim();
      if (!name) { setError('New Client Name is required.'); return; }
      payload.newClientName = name;
      successLabel = `Client to Client (${name}) — moved directly to ${destLabel}`;
    } else if (reason === 'Client Scope') {
      const scope = clientScope.trim();
      if (!scope) { setError('Scope is required.'); return; }
      payload.clientScope = scope;
      successLabel = `Client Scope (${scope}) — moved directly to ${destLabel}`;
    } else {
      const ct = commentType.trim();
      if (!ct) { setError('Comment / Type is required.'); return; }
      payload.commentType = ct;
      successLabel = `Other (${ct}) — moved directly to ${destLabel}`;
    }

    setBusy(true);
    try {
      await submitMoveToStage(containerNo, payload);
      setDone({ reason, label: successLabel });
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className={styles.savedPanel}>
        <p className={styles.savedTitle}>Moved</p>
        <p className={styles.savedHint}>{containerNo} is recorded as moved — {done.label}.</p>
        <div className={styles.savedActions}>
          <Button type="button" variant="primary" onClick={onMoved}>Done</Button>
        </div>
      </div>
    );
  }

  /* REVERSED 2026-09-24 (explicit, repeated request — overrides this
     component's own earlier "usable only when STAGE-8 is ABSENT" design):
     the form now stays locked until STAGE-8 IS found for this container,
     not the other way around. This inverts the feature's original "escape
     hatch for containers with no FMS data" purpose, but the user confirmed
     this exact behavior twice, in plain terms, after I raised the
     conflict — so it stands as stated. */
  const locked = busy || !canMove || !fmsChecked || !fmsFound;

  return (
    <div className={styles.fmsWrap}>
      <h3 className={styles.sectionTitle}>Move To Stage</h3>
      <div className={styles.fieldGrid}>
        <Field
          field={{ key: 'reason', label: 'Reason', type: 'select', options: MOVE_REASON_OPTIONS }}
          value={reason}
          onChange={(v) => { setReason(v); setError(''); }}
          disabled={locked}
        />
        {reason === 'Client to Client' && (
          <Field
            field={{ key: 'newClientName', label: 'New Client Name', type: 'text', required: true }}
            value={newClientName}
            onChange={setNewClientName}
            disabled={locked}
          />
        )}
        {reason === 'Client Scope' && (
          <Field
            field={{ key: 'clientScope', label: 'Scope', type: 'text', required: true }}
            value={clientScope}
            onChange={setClientScope}
            disabled={locked}
          />
        )}
        {reason === 'Other' && (
          <Field
            field={{ key: 'commentType', label: 'Comment / Type', type: 'text', required: true }}
            value={commentType}
            onChange={setCommentType}
            disabled={locked}
          />
        )}
        {reason && (
          <>
            <Field
              field={{ key: 'moveRemarks', label: 'Remarks', type: 'textarea' }}
              value={remarks}
              onChange={setRemarks}
              disabled={locked}
            />
            <Field
              field={{ key: 'moveDate', label: 'Lifting Date', type: 'date', required: true }}
              value={date}
              onChange={setDate}
              disabled={locked}
            />
            <Field
              field={{ key: 'moveToStage', label: 'Move To Stage', type: 'select', options: MOVE_JUMP_TARGET_OPTIONS, required: true }}
              value={moveToStage}
              onChange={setMoveToStage}
              disabled={locked}
            />
          </>
        )}
      </div>

      {error && <div className={styles.error}>{error}</div>}
      {!canMove && <p className={styles.sectionHint}>You don't have permission to move this stage.</p>}
      {canMove && !fmsChecked && <p className={styles.sectionHint}>Checking STAGE-8 for this container — Move To Stage unlocks once that finishes.</p>}
      {canMove && fmsChecked && !fmsFound && (
        <p className={styles.sectionHint}>
          No STAGE-8 movement record found for this container yet — Move To Stage stays locked until one is fetched.
        </p>
      )}

      {reason && (
        <div className={styles.actions}>
          <Button type="button" variant="primary" loading={busy} disabled={locked} onClick={handleMove}>
            {busy ? 'Moving…' : 'Move'}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * Shown on whichever stage (Gate In / Inspection / Billing) a record was
 * directly jumped to via Move To Stage (Reason = "Other") — see
 * getOffLeaseStageDetail's `_move.canSendBackHere` on the backend. Reverses
 * the jump: the record returns to Stage 2's own pending queue, the same row
 * (nothing duplicated), with its full history preserved in the separate
 * audit-trail sheet regardless.
 */
function SendBackPanel({ containerNo, rowNum, moveInfo, onSentBack }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const handleSendBack = async () => {
    setError('');
    setBusy(true);
    try {
      await submitSendBack(containerNo, rowNum);
      onSentBack?.();
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.savedPanel}>
      <p className={styles.savedTitle}>Moved here via Move To Stage</p>
      <p className={styles.savedHint}>
        Reason: {moveInfo.reason}
        {moveInfo.commentType ? ` — ${moveInfo.commentType}` : ''}
        {moveInfo.newClientName ? ` · New Client: ${moveInfo.newClientName}` : ''}
        {moveInfo.clientScope ? ` · Scope: ${moveInfo.clientScope}` : ''}
        {moveInfo.arrivalDate ? ` · Arrival: ${moveInfo.arrivalDate}` : ''}
        {moveInfo.date ? ` · ${moveInfo.date}` : ''}
        {moveInfo.remarks ? ` · ${moveInfo.remarks}` : ''}
      </p>
      {error && <div className={styles.error}>{error}</div>}
      <div className={styles.savedActions}>
        <Button type="button" variant="secondary" loading={busy} onClick={handleSendBack}>
          {busy ? 'Sending back…' : 'Send Back'}
        </Button>
      </div>
    </div>
  );
}

function SourceCard({ title, rows, empty, show, unread }) {
  /* `show` decides whether the section exists at all; `rows` only decides
     what it says. Keying visibility off the data meant an unexpected shape —
     a cached object without its fields — made the whole section disappear
     with no indication anything was wrong. */
  if (!show) return null;
  const has = Array.isArray(rows) && rows.length > 0;
  return (
    <>
      <h3 className={styles.sectionTitle}>{title}</h3>
      {has
        ? (
          <div className={styles.baseGrid}>
            {rows.map(([label, value]) => (
              <div key={label} className={styles.baseItem}>
                <span className={styles.baseLabel}>{label}</span>
                {/* renderCellValue turns a URL into a clickable 📎 — the
                    Delivery Order arrives here as its link, not "View DO". */}
                <span className={styles.baseValue}>{renderCellValue(value)}</span>
              </div>
            ))}
          </div>
        )
        : (
          <p className={styles.sectionHint}>
            {unread
              ? 'Could not read this sheet — Google Sheets read quota exhausted. Retry shortly.'
              : empty}
          </p>
        )}
    </>
  );
}

function BillingTable({ billing, clientName }) {
  const money = (v) => {
    const n = Number(String(v ?? '').replace(/,/g, '').trim());
    return Number.isFinite(n) && String(v ?? '').trim() !== '' ? n.toLocaleString('en-IN') : '—';
  };
  return (
    <>
      <h3 className={styles.sectionTitle}>Billing (from Billing Sales)</h3>
      <p className={styles.sectionHint}>
        {billing.count} invoice{billing.count === 1 ? '' : 's'} for this container · Total {money(billing.totalBilling)}
      </p>
      <table className={styles.inspTable}>
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">Container No</th>
            <th scope="col">Client Name</th>
            <th scope="col">Invoice No</th>
            <th scope="col">Attachment</th>
            <th scope="col">Amount</th>
          </tr>
        </thead>
        <tbody>
          {billing.records.map((r, i) => (
            <tr key={`${r.invoiceNo}-${i}`}>
              <td className={styles.inspNum}>{i + 1}</td>
              <td className={styles.inspPoint}>{r.container || billing.container || '—'}</td>
              <td>{clientName || billing.clientName || r.clientName || '—'}</td>
              <td>{r.invoiceNo || '—'}</td>
              <td>
                {/^https?:\/\//i.test(r.attachment)
                  ? <a href={r.attachment} target="_blank" rel="noreferrer">Open</a>
                  : '—'}
              </td>
              <td>{money(r.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function ChecklistTable({ title, columnLabel, rows, footer = [], values, pendingFiles, disabled, onChange, onFile }) {
  /* Estimate/Photo/Remarks were a second row that opened up underneath a
     damaged point — one line per point became two, and the whole table
     re-flowed every time a dropdown changed. Same fix as the read-only
     report view (offLease/LookupResult.jsx's own ChecklistTable): once ANY
     point needs them, they become three more COLUMNS every row already has
     (dash for a sound point), so a damaged point is still exactly one row,
     not a row plus an expanding panel below it. */
  const anyDamage = rows.some((row) => isFaultStatus(String(values[row.status.key] || '')));

  return (
    <>
      <h3 className={styles.sectionTitle}>{title}</h3>
      <p className={styles.sectionHint}>
        Mark each point&apos;s condition. Anything other than Good, OK or Not Required asks for that point&apos;s estimate value, photo and remarks.
      </p>

      <table className={styles.inspTable}>
        <thead>
          <tr>
            <th scope="col">{columnLabel}</th>
            <th scope="col">Good / Damage</th>
            {anyDamage && DAMAGE_ROLES.map(([role, shortLabel]) => <th key={role} scope="col">{shortLabel}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const statusField = row.status;
            const selected = String(values[statusField.key] || '');
            /* Any fault wording asks for the extra columns — Rusty, Leak,
               Short, Noisy, Faulty, Cut, Missing, Safety Pin Cut — not just
               "Damage". Must use the same predicate the fields' showIf uses,
               or a point could ask for values it never actually shows a
               place to enter. */
            const damaged = isFaultStatus(selected);

            return (
              <tr key={row.n}>
                <td className={styles.inspPoint}>
                  <span className={styles.inspNum}>{row.n}.</span>{row.item}
                </td>
                <td>
                  {/* A dropdown rather than a row of radios: points carry up
                      to four options, which wrapped onto a second line and
                      made the rows ragged. The control keeps the colour
                      signal — red for a fault, green for sound. */}
                  <select
                    className={`${styles.statusSelect} ${statusTone(selected, styles)}`}
                    value={selected}
                    onChange={(e) => onChange(statusField.key, e.target.value)}
                    disabled={disabled}
                    aria-label={`${row.item} condition`}
                  >
                    <option value="">Select…</option>
                    {statusField.options.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                  </select>
                </td>
                {anyDamage && DAMAGE_ROLES.map(([role]) => {
                  const f = row[role];
                  if (!damaged || !f) return <td key={role} className={styles.inspDamageDash}>—</td>;
                  return (
                    <td key={role} className={styles.inspDamageCol}>
                      <Field
                        field={{ ...f, label: '' }}
                        value={values[f.key]}
                        pendingFileName={pendingFiles[f.key]?.fileName}
                        onChange={(v) => onChange(f.key, v)}
                        onFile={(payload) => onFile(f.key, payload)}
                        disabled={disabled}
                      />
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>

      {footer.length > 0 && (
        <div className={styles.checklistFooter}>
          {footer.map((f) => (
            <Field
              key={f.key}
              field={f}
              value={f.type === 'computed' ? f.compute(values) : values[f.key]}
              onChange={(v) => onChange(f.key, v)}
              disabled={disabled}
            />
          ))}
        </div>
      )}
    </>
  );
}

/**
 * Site Cabin fittings inventory — expected quantity against the quantity
 * actually found. Expected comes from the cabin spec for this container's
 * size; a size with no spec yet shows "—" rather than a wrong number.
 * A shortfall is highlighted so it is obvious at a glance.
 */
function CabinTable({ fields, size, values, disabled, onChange }) {
  const sizeKey = normaliseSize(size);
  return (
    <>
      <h3 className={styles.sectionTitle}>Site Cabin Fittings</h3>
      <p className={styles.sectionHint}>
        Expected quantities for {sizeKey || 'this size'}. Enter how many are actually present.
      </p>

      <table className={styles.inspTable}>
        <thead>
          <tr>
            <th scope="col">Sr. No.</th>
            <th scope="col">Items</th>
            <th scope="col">Qty</th>
            <th scope="col">Available</th>
          </tr>
        </thead>
        <tbody>
          {fields.map((f) => {
            const expected = cabinExpectedQty({ qty: f.cabin.qty }, size);
            const raw = values[f.key];
            const available = String(raw ?? '').trim();
            // Only flag a shortfall when both sides are actually numeric —
            // a column may hold stray text left behind by a sheet edit.
            const short = expected !== '' && available !== '' &&
              Number.isFinite(Number(available)) && Number(available) < Number(expected);
            return (
              <tr key={f.key}>
                <td className={styles.inspNum}>{f.cabin.n}</td>
                <td className={styles.inspPoint}>{f.cabin.item}</td>
                <td>{expected === '' ? '—' : expected}</td>
                <td>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    className={`${styles.cabinQty} ${short ? styles.cabinShort : ''}`}
                    value={raw ?? ''}
                    onChange={(e) => onChange(f.key, e.target.value)}
                    disabled={disabled}
                    aria-label={`${f.cabin.item} available`}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

/**
 * Remarks scoped to ONE stage — a separate thread from the dashboard's own
 * record-wide commentary (OrderBookView's RemarkCell), tagged with this
 * stageNumber (offleaseRemarks.service.js's `stage` column, added 2026-09-02).
 * Modeled on that same component's composer (RichTextEditor + Cancel/Save)
 * but shown in full rather than behind a hover rail — a modal has the room a
 * dashboard cell does not.
 */
function StageRemarks({ containerNo, leaseId, stageNumber }) {
  const [thread, setThread] = useState(null);
  const [threadBusy, setThreadBusy] = useState(false);
  const [threadError, setThreadError] = useState('');
  const [open, setOpen] = useState(false);
  const [html, setHtml] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setThread(null);
    setThreadBusy(true);
    setThreadError('');
    fetchRemarkThread(containerNo, leaseId, stageNumber)
      .then((r) => { if (!cancelled) setThread(r); })
      .catch((e) => { if (!cancelled) setThreadError(apiErrorMessage(e)); })
      .finally(() => { if (!cancelled) setThreadBusy(false); });
    return () => { cancelled = true; };
  }, [containerNo, leaseId, stageNumber]);

  const beginEdit = (r) => {
    setEditingId(r.id);
    setHtml(r.html);
    setError('');
    setOpen(true);
  };

  const save = async () => {
    setError('');
    setBusy(true);
    try {
      const saved = editingId
        ? await editRemark(containerNo, editingId, html)
        : await postRemark(containerNo, leaseId, html, stageNumber);
      setOpen(false);
      setEditingId(null);
      setHtml('');
      setThread((t) => {
        const list = t || [];
        return editingId
          ? list.map((r) => (r.id === editingId ? { ...r, html: saved?.html ?? html } : r))
          : [{ ...saved, id: saved?.id }, ...list];
      });
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (r) => {
    setThreadError('');
    setBusy(true);
    try {
      await removeRemark(containerNo, r.id);
      setThread((t) => (t || []).filter((x) => x.id !== r.id));
    } catch (e) {
      setThreadError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.stageRemarks}>
      <div className={styles.stageRemarksHead}>
        <span className={styles.sectionTitle}>Remarks for this stage</span>
        {!open && (
          <button
            type="button"
            className={styles.stageRemarksAdd}
            onClick={() => { setEditingId(null); setHtml(''); setError(''); setOpen(true); }}
          >
            <Icon name="edit" className={styles.stageRemarksAddIcon} />
            Add a remark
          </button>
        )}
      </div>

      {threadBusy && !thread && <p className={styles.stageRemarksMeta}>Loading…</p>}
      {threadError && <p className={styles.error}>{threadError}</p>}
      {thread && !thread.length && !open && <p className={styles.stageRemarksEmpty}>No remarks on this stage yet.</p>}

      {thread?.map((r) => (
        <div className={styles.stageRemarkItem} key={r.id}>
          <div className={styles.stageRemarkBody} dangerouslySetInnerHTML={{ __html: r.html }} />
          <div className={styles.stageRemarkFoot}>
            <span className={styles.stageRemarksMeta}>
              {[formatActionTimestamp(r.timestamp), r.enteredBy].filter(Boolean).join(' · ')}
              {r.editedOn && ' · edited'}
            </span>
            <button type="button" className={styles.stageRemarkAction} onClick={() => beginEdit(r)}>Edit</button>
            <button
              type="button"
              className={`${styles.stageRemarkAction} ${styles.stageRemarkDanger}`}
              onClick={() => remove(r)}
              disabled={busy}
            >
              Delete
            </button>
          </div>
        </div>
      ))}

      {open && (
        <div className={styles.stageRemarksEditor}>
          <RichTextEditor
            value={html}
            onChange={setHtml}
            placeholder={editingId ? 'Edit this remark…' : 'Add a remark…'}
            disabled={busy}
            autoFocus
          />
          {error && <p className={styles.error}>{error}</p>}
          <div className={styles.stageRemarksActions}>
            <Button
              size="sm" variant="secondary" disabled={busy}
              onClick={() => { setOpen(false); setEditingId(null); setHtml(''); setError(''); }}
            >
              Cancel
            </Button>
            <Button size="sm" variant="primary" loading={busy} onClick={save}>
              {editingId ? 'Update' : 'Save'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ field, value, pendingFileName, onChange, onFile, disabled }) {
  const { label, type, options = [], required } = field;

  if (type === 'text') {
    return (
      <Labeled label={label} required={required}>
        <input type="text" value={value || ''} onChange={(e) => onChange(e.target.value)} disabled={disabled} />
      </Labeled>
    );
  }
  if (type === 'textarea') {
    return (
      <Labeled label={label} required={required} full>
        <textarea rows={3} value={value || ''} onChange={(e) => onChange(e.target.value)} disabled={disabled} />
      </Labeled>
    );
  }
  if (type === 'number') {
    return (
      <Labeled label={label} required={required}>
        <input type="number" step="any" value={value || ''} onChange={(e) => onChange(e.target.value)} disabled={disabled} />
      </Labeled>
    );
  }
  /* Derived and written by the server (technician cost = hours x rate) — shown
     so the inspector sees the figure, never editable and never submitted. */
  if (type === 'computed') {
    return (
      <Labeled label={label}>
        <output className={styles.computed}>{value === '' || value == null ? '—' : value}</output>
      </Labeled>
    );
  }
  if (type === 'date') {
    return (
      <Labeled label={label} required={required}>
        <input type="date" value={value || ''} onChange={(e) => onChange(e.target.value)} disabled={disabled} />
      </Labeled>
    );
  }
  if (type === 'datetime') {
    return (
      <Labeled label={label} required={required}>
        <input type="datetime-local" value={value || ''} onChange={(e) => onChange(e.target.value)} disabled={disabled} />
      </Labeled>
    );
  }
  if (type === 'select') {
    // Plain strings (every existing field) use the same text as value and
    // label; {value, label} lets a field show a friendlier label (e.g. "Stage
    // 3 – Gate In") than what's actually submitted (e.g. "3").
    const opts = options.map((o) => (typeof o === 'object' && o !== null ? o : { value: o, label: o }));
    return (
      <Labeled label={label} required={required}>
        <select value={value || ''} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
          <option value="">Select…</option>
          {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </Labeled>
    );
  }
  if (type === 'selectOther') {
    return (
      <Labeled label={label} required={required}>
        <SelectOtherInput options={options} value={value} onChange={onChange} disabled={disabled} />
      </Labeled>
    );
  }
  if (type === 'radio') {
    return (
      <Labeled label={label} required={required}>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          {options.map((o) => (
            <label key={o} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 13, fontWeight: 500 }}>
              <input
                type="radio"
                name={field.key}
                value={o}
                checked={value === o}
                onChange={() => onChange(o)}
                disabled={disabled}
              />
              {o}
            </label>
          ))}
        </div>
      </Labeled>
    );
  }
  if (type === 'file') {
    return (
      <Labeled label={label} required={required}>
        <FileFieldInput value={value} pendingFileName={pendingFileName} onFile={onFile} disabled={disabled} />
      </Labeled>
    );
  }
  if (type === 'imagesToPdf') {
    return (
      <Labeled label={label} required={required}>
        <ImagesToPdfFieldInput value={value} pendingFileName={pendingFileName} onFile={onFile} disabled={disabled} />
      </Labeled>
    );
  }
  return null;
}

function FileFieldInput({ value, pendingFileName, onFile, disabled }) {
  const [busy, setBusy] = useState(false);

  const handleChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const base64Data = await readFileAsBase64(file);
      onFile({ base64Data, mimeType: file.type || 'application/octet-stream', fileName: file.name });
    } finally {
      setBusy(false);
      e.target.value = '';
    }
  };

  const [dragging, setDragging] = useState(false);

  const take = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      const base64Data = await readFileAsBase64(file);
      onFile({ base64Data, mimeType: file.type || 'application/octet-stream', fileName: file.name });
    } finally { setBusy(false); }
  };

  const uploaded = value && /^https?:\/\//.test(value);
  const state = busy ? 'busy' : pendingFileName ? 'pending' : uploaded ? 'done' : 'empty';

  /* A dashed drop target that fills in once a file is attached, rather than a
     text link. The three states are visually distinct because "not uploaded",
     "chosen but not saved yet" and "already on the record" are three different
     situations, and a single blue link said nothing about which one you were
     looking at. */
  return (
    <label
      className={`${styles.drop} ${styles[`drop_${state}`]} ${dragging ? styles.dropOver : ''}`}
      onDragOver={(e) => { if (!disabled) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => { if (disabled) return; e.preventDefault(); setDragging(false); take(e.dataTransfer.files?.[0]); }}
    >
      <Icon name={state === 'done' ? 'check' : 'upload'} className={styles.dropIcon} />

      <span className={styles.dropText}>
        {state === 'busy' && 'Reading…'}
        {state === 'pending' && (
          <>
            <span className={styles.dropName}>{pendingFileName}</span>
            <span className={styles.dropHint}>Not saved yet</span>
          </>
        )}
        {state === 'done' && (
          <>
            <span className={styles.dropName}>File attached</span>
            <span className={styles.dropHint}>Click to replace</span>
          </>
        )}
        {state === 'empty' && (
          <>
            <span className={styles.dropName}>Upload</span>
            <span className={styles.dropHint}>or drop a file</span>
          </>
        )}
      </span>

      {/* Opening the stored file must NOT also open the file picker. */}
      {uploaded && (
        <a
          href={value}
          target="_blank"
          rel="noreferrer"
          className={styles.dropView}
          onClick={(e) => e.stopPropagation()}
        >
          View
        </a>
      )}

      {!disabled && <input type="file" onChange={handleChange} disabled={busy} hidden />}
    </label>
  );
}

/**
 * Stage 1's "Container Photos" field — explicit request 2026-09-23: pick
 * several photos at once, combined into ONE PDF client-side (jsPDF, same
 * library the Off-Lease container-report/lookup exports already use — see
 * pdfLayout.js), so Stage 1A only ever has one file to open instead of
 * juggling N separate uploads. The merged PDF is then just a normal 'file'
 * value from here on: it goes through the exact same deferred-upload path
 * as FileFieldInput (onFile here hands off a base64 payload; the actual
 * Drive upload happens at Save Stage, in the modal's own submit handler).
 * Each photo is scaled to fit one A4 page, preserving its own aspect ratio.
 */
function ImagesToPdfFieldInput({ value, pendingFileName, onFile, disabled }) {
  const [busy, setBusy] = useState(false);

  const handleChange = async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    setBusy(true);
    try {
      const doc = new jsPDF({ unit: 'mm', format: 'a4' });
      const pageW = doc.internal.pageSize.getWidth();
      const pageH = doc.internal.pageSize.getHeight();
      const margin = 10;
      const maxW = pageW - margin * 2;
      const maxH = pageH - margin * 2;

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const dataUrl = await readFileAsDataUrl(file);
        const { width, height } = await loadImageDimensions(dataUrl);
        const scale = Math.min(maxW / width, maxH / height, 1);
        const w = width * scale;
        const h = height * scale;
        const x = margin + (maxW - w) / 2;
        const y = margin + (maxH - h) / 2;
        if (i > 0) doc.addPage();
        // jsPDF only reads pixel data for PNG/JPEG — everything else (HEIC,
        // WEBP, ...) is passed through as JPEG, which is wrong for a format
        // it can't decode but is at least consistent with what browsers
        // already re-encode most phone camera uploads as by this point.
        const format = /png/i.test(file.type) ? 'PNG' : 'JPEG';
        doc.addImage(dataUrl, format, x, y, w, h);
      }

      const base64Data = doc.output('datauristring').split(',')[1] || '';
      const fileName = `Container Photos - ${files.length} photo${files.length === 1 ? '' : 's'}.pdf`;
      onFile({ base64Data, mimeType: 'application/pdf', fileName });
    } finally {
      setBusy(false);
      e.target.value = '';
    }
  };

  const uploaded = value && /^https?:\/\//.test(value);
  const state = busy ? 'busy' : pendingFileName ? 'pending' : uploaded ? 'done' : 'empty';

  return (
    <label className={`${styles.drop} ${styles[`drop_${state}`]}`}>
      <Icon name={state === 'done' ? 'check' : 'upload'} className={styles.dropIcon} />

      <span className={styles.dropText}>
        {state === 'busy' && 'Combining photos into a PDF…'}
        {state === 'pending' && (
          <>
            <span className={styles.dropName}>{pendingFileName}</span>
            <span className={styles.dropHint}>Not saved yet</span>
          </>
        )}
        {state === 'done' && (
          <>
            <span className={styles.dropName}>PDF attached</span>
            <span className={styles.dropHint}>Click to replace</span>
          </>
        )}
        {state === 'empty' && (
          <>
            <span className={styles.dropName}>Select photos</span>
            <span className={styles.dropHint}>multiple allowed — combined into one PDF</span>
          </>
        )}
      </span>

      {uploaded && (
        <a
          href={value}
          target="_blank"
          rel="noreferrer"
          className={styles.dropView}
          onClick={(e) => e.stopPropagation()}
        >
          View
        </a>
      )}

      {!disabled && <input type="file" accept="image/*" multiple onChange={handleChange} disabled={busy} hidden />}
    </label>
  );
}

/** Full data: URL (unlike readFileAsBase64 below, which strips the prefix
 *  for the upload payload) — jsPDF's addImage needs the data: URI itself. */
function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/** Natural pixel size of an image, from its data URL — needed to scale each
 *  photo onto its PDF page without distorting it. */
function loadImageDimensions(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = reject;
    img.src = dataUrl;
  });
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/** Select-with-free-text-Other, used by Stage 6's Size/Container Type/Quantity fields. */
function SelectOtherInput({ options, value, onChange, disabled }) {
  const [otherMode, setOtherMode] = useState(() => !!value && !options.includes(value));

  useEffect(() => {
    if (value && !options.includes(value)) setOtherMode(true);
  }, [value, options]);

  const handleSelect = (e) => {
    const v = e.target.value;
    if (v === 'Other') {
      setOtherMode(true);
      onChange('');
    } else {
      setOtherMode(false);
      onChange(v);
    }
  };

  return (
    <>
      <select value={otherMode ? 'Other' : (value || '')} onChange={handleSelect} disabled={disabled}>
        <option value="">Select…</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
        <option value="Other">Other</option>
      </select>
      {otherMode && (
        <input
          type="text"
          placeholder="Specify…"
          style={{ marginTop: 6 }}
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
        />
      )}
    </>
  );
}

function Labeled({ label, required, full, children }) {
  return (
    <label className={`${styles.field} ${full ? styles.full : ''}`}>
      {/* Empty label (ChecklistTable's per-column cells, where the column
          header already names the field) renders no span at all, rather
          than an empty one still claiming its own line of vertical space. */}
      {label && <span className={styles.label}>{label}{required && <span className={styles.req}> *</span>}</span>}
      {children}
    </label>
  );
}
