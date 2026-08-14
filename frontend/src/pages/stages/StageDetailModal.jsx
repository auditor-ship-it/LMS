import { Fragment, useEffect, useMemo, useState } from 'react';
import { Button } from '../../components/ui/Button.jsx';
import { renderCellValue } from '../../components/ui/CellValue.jsx';
import { LoadingState } from '../../components/ui/LoadingState.jsx';
import { ErrorState } from '../../components/ui/ErrorState.jsx';
import { apiErrorMessage } from '../../shared/auth/index.js';
import { fetchStageDetail, fetchNextLeaseId, submitStage } from '../../services/stage.service.js';
import { lookupContainer } from '../../services/offLease.service.js';
import { getOutstanding } from '../../api/offlease.api.js';
import { exportLookupToPdf } from '../offLease/lookupExport.js';
import { uploadStageFile } from '../../services/upload.service.js';
import { useAsync } from '../../hooks/useAsync.js';
import { BASE_FIELDS, STAGE_FIELDS, cabinExpectedQty, normaliseSize, isFaultStatus, SOUND_STATUSES } from './stageFields.js';
import { stageCaption } from '../../constants/stages.js';
import styles from './StageDetailModal.module.css';

/** Invoice numbers are spelled with different separators and case across the
 *  two systems; compared on alphanumerics alone so they still match. */
const normInvoiceNo = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * Detail/edit form for one Off-Lease row at one stage. Fields shown are
 * exactly STAGE_FIELDS[stageNumber] (never hand-written per stage — Stage 6
 * alone has 53). Pre-filled via GET /offlease/:containerNo/stage/:stage; submits
 * only the visible field keys back to POST /offlease/:containerNo/stage/:stage.
 */
// The heading comes from stageCaption(stageNumber), so no label prop is needed.
export function StageDetailModal({ stageNumber, containerNo, readOnly, identityOnly, movement, transport, delivery, onClose, onSaved }) {
  const fields = STAGE_FIELDS[stageNumber] || [];
  const { data, loading, error, reload } = useAsync(() => fetchStageDetail(containerNo, stageNumber), [containerNo, stageNumber]);
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
     Collection app via our own proxy. Stage 1 only — it is the figure the
     intimation decision is made against. */
  const { data: outstanding, loading: outstandingLoading } = useAsync(
    () => (stageNumber === 1 && containerNo
      ? getOutstanding(containerNo, data?.col_5 || '')
      : Promise.resolve(null)),
    [stageNumber, containerNo, data?.col_5]
  );
  /* Report stages don't close on save — the inspector is offered the report
     for the record they just completed before the modal goes away. */
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
    if (data) setValues(data);
  }, [data]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

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
      const message = await submitStage(containerNo, stageNumber, payload);
      if (message === 'ALREADY_PROCESSED') {
        setSaveError('This record was already processed by someone else — refreshing…');
        reload();
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

  return (
    <div className={styles.backdrop} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={styles.modal} role="dialog" aria-modal="true" aria-label={stageCaption(stageNumber)}>
        <div className={styles.header}>
          <h2 className={styles.title}>{stageCaption(stageNumber)}</h2>
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

              {/* FMS movement + transport detail, matched on Container No and
                  Client Name with Movement Type = Offlease. */}
              {/* `fields` is the WHOLE matched row, labelled with that tab's
                  own headers — every column it actually filled in, not a
                  hand-picked subset. */}
              {/* FMS pipeline at a glance — which of STAGE-8/9/10 actually has
                  a record for this container, without scrolling three cards. */}
              {identityOnly && (
                <FmsPipeline steps={[
                  { n: 8, label: 'Movement', state: fmsState(movement) },
                  { n: 9, label: 'Transport', state: fmsState(transport) },
                  { n: 10, label: 'Site Delivery', state: fmsState(delivery) }
                ]} />
              )}

              {/* undefined = the sheet could not be read; null = read fine,
                  no matching row. Those are different facts and must not read
                  the same to the user. */}
              <SourceCard
                show={identityOnly}
                title="Stage 8 — Offlease Movement"
                unread={movement === undefined}
                empty="No Offlease movement logged in STAGE-8 for this container and client."
                rows={movement?.fields}
              />
              <SourceCard
                show={identityOnly}
                title="Stage 9 — Transport"
                unread={transport === undefined}
                empty="No Offlease transport logged in STAGE-9 for this container and client."
                rows={transport?.fields}
              />
              <SourceCard
                show={identityOnly}
                title="Stage 10 — Site Delivery"
                unread={delivery === undefined}
                empty="No STAGE-10 record found for this container's DO number."
                rows={delivery?.fields}
              />

              {stageNumber === 1 && (
                <OutstandingPanel data={outstanding} loading={outstandingLoading} />
              )}

              {billing && <BillingTable billing={billing} clientName={data?.col_5} />}

              {/* identityOnly: the container's own details and nothing else.
                  Stage 2 is a read-only master list, so opening a row is for
                  looking up who and what the container is — its stage fields
                  are not part of that. */}
              {!identityOnly && (
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

              {!identityOnly && checklists.map((c) => (
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

              {!identityOnly && cabinFields.length > 0 && (
                <CabinTable
                  fields={cabinFields}
                  size={data?.col_2}
                  values={values}
                  disabled={readOnly || busy}
                  onChange={setField}
                />
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
                {!readOnly && (
                  <Button type="submit" variant="primary" loading={busy}>
                    {uploading ? 'Uploading files…' : saving ? 'Saving…' : 'Save Stage'}
                  </Button>
                )}
              </div>
            </form>
          )}
        </div>
      </div>
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
 * Stages that offer the inspection report: Stage 3 captures it, and Billing
 * (internally stage 5, shown as Stage 4) needs to read it before invoicing.
 * These are INTERNAL stage numbers.
 */
const REPORT_STAGES = [3, 5];

/** Billing Reconciliation (internally stage 5, shown as Stage 4) — the person
 *  reconciling needs the container's actual invoices in front of them. */
const BILLING_STAGE = 5;

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
                <td className={styles.invNo}>{i.invoiceNo || '—'}</td>
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
                {/* The invoice PDF, keyed on invoice number from Billing Sales
                    — a 📎 that opens the file, or a dash when none is on the
                    sheet for it. */}
                <td className={styles.tCenter}>
                  {renderCellValue(invoiceFiles[normInvoiceNo(i.invoiceNo)] || '')}
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
    </>
  );
}

/**
 * A labelled block of read-only values from one of the FMS tabs. Renders
 * nothing at all when that tab was not consulted for this stage, and an
 * explicit note when it was consulted but found no match — "no row matched" is
 * information, whereas a silently absent section reads as an oversight.
 */
/** undefined = sheet unreadable, null = read but no row, object = found. */
const fmsState = (v) => (v === undefined ? 'unread' : v ? 'found' : 'missing');

const FMS_TEXT = { found: 'Fetched', missing: 'No record', unread: 'Unavailable' };

/** STAGE-8 -> 9 -> 10, showing which legs this container actually has. */
function FmsPipeline({ steps }) {
  return (
    <div className={styles.fmsRow}>
      {steps.map((s) => (
        <div key={s.n} className={`${styles.fmsStep} ${styles[`fms_${s.state}`]}`}>
          <span className={styles.fmsNum}>{s.n}</span>
          <span className={styles.fmsLabel}>{s.label}</span>
          <span className={styles.fmsState}>{FMS_TEXT[s.state]}</span>
        </div>
      ))}
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
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const statusField = row.status;
            const selected = String(values[statusField.key] || '');
            /* Any fault wording opens the panel — Rusty, Leak, Short, Noisy,
               Faulty, Cut, Missing, Safety Pin Cut — not just "Damage". Must
               use the same predicate the fields' showIf uses, or the fields
               become visible while the row that renders them stays closed. */
            const damaged = isFaultStatus(selected);

            return (
              <Fragment key={row.n}>
                <tr>
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
                </tr>

                {damaged && DAMAGE_ROLES.some(([role]) => row[role]) && (
                  <tr>
                    <td className={styles.inspDamageCell} colSpan={2}>
                      <div className={styles.inspDamageBox}>
                        {DAMAGE_ROLES.filter(([role]) => row[role]).map(([role, shortLabel]) => {
                          const f = row[role];
                          return (
                            <Field
                              key={f.key}
                              field={{ ...f, label: shortLabel }}
                              value={values[f.key]}
                              pendingFileName={pendingFiles[f.key]?.fileName}
                              onChange={(v) => onChange(f.key, v)}
                              onFile={(payload) => onFile(f.key, payload)}
                              disabled={disabled}
                            />
                          );
                        })}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
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
    return (
      <Labeled label={label} required={required}>
        <select value={value || ''} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
          <option value="">Select…</option>
          {options.map((o) => <option key={o} value={o}>{o}</option>)}
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

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      {value && /^https?:\/\//.test(value) && (
        <a href={value} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: 'var(--blue-600)' }}>View current file</a>
      )}
      {pendingFileName && <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{pendingFileName} (pending upload)</span>}
      {!disabled && (
        <label style={{ fontSize: 12, cursor: 'pointer', color: 'var(--blue-600)', fontWeight: 700 }}>
          {busy ? 'Reading…' : value ? 'Replace file' : 'Choose file'}
          <input type="file" onChange={handleChange} disabled={busy} hidden />
        </label>
      )}
    </div>
  );
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
      <span className={styles.label}>{label}{required && <span className={styles.req}> *</span>}</span>
      {children}
    </label>
  );
}
