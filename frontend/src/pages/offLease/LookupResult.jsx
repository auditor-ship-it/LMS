import { renderCellValue } from '../../components/ui/CellValue.jsx';
import { formatActionTimestamp } from '../../utils/formatDateTime.js';
import {
  buildIdentityRows, buildHistoryRows, buildMovements, buildInvoices,
  HISTORY_HEAD, MOVEMENT_HEAD, INVOICE_HEAD, slaText
} from './lookupModel.js';
import styles from './LookupResult.module.css';

/**
 * Container lookup result card — identity fields, an 8-stage progress board
 * (plus the Intimation Approval gate between Stage 1 and Stage 2), and a
 * "Filled Stage Data" section showing every field captured so far for each
 * completed stage. All of this data was already returned by
 * GET /offlease/:containerNo/detail (`stages[].fields`, `approvalStatus`,
 * etc.) — this is a rendering-only change, no backend/API change needed.
 * The field list itself lives in lookupModel.js so the Excel/PDF download of
 * this same result stays in step with what's on screen. `rate` is
 * deliberately NOT rendered (system-wide convention: pricing is hidden from
 * every grid/detail view — see utils/isRateOrAmountHeader.js), even though
 * the API response includes it.
 */
export function LookupResult({ result }) {
  const {
    container, clientCode, clientName, inOffLease, approvalStatus,
    approvalDate, approvalUser, stages = [], currentStage
  } = result;

  const identity = buildIdentityRows(result);

  // First not-yet-done stage is the one "in progress" — everything after it
  // is just future/locked, same distinction the identity-grid stagePill
  // above already implies via currentStage.
  const currentStageNum = stages.find((s) => !s.done)?.stage;
  const approvalLower = String(approvalStatus || '').trim().toLowerCase();
  const filledStages = stages.filter((s) => s.done);

  return (
    <div className={styles.wrap}>
      <div className={styles.header}>
        <div>
          <div className={styles.container}>{container}</div>
          <div className={styles.client}>{clientName}{clientCode ? ` · ${clientCode}` : ''}</div>
        </div>
        <span className={styles.stagePill}>{currentStage}</span>
      </div>

      <div className={styles.grid}>
        {identity.map(([label, value]) => (
          <div key={label} className={styles.item}>
            <span className={styles.label}>{label}</span>
            <span className={styles.value}>{value || '—'}</span>
          </div>
        ))}
      </div>

      {/* The whole history in one ordered table — Stage 1 through Stage 9,
          including movements, so a single screen answers "what has happened to
          this container". The progress board and per-stage cards below expand
          on it; this is the summary you read first. */}
      {inOffLease && stages.length > 0 && (
        <>
          <h4 className={styles.sectionTitle}>Container History — Stage 1 to Stage 9</h4>
          <HistoryTable rows={buildHistoryRows(result)} />
        </>
      )}

      <InvoicesSection invoices={buildInvoices(result)} />

      <MovementsSection movements={buildMovements(result)} error={result.movementsError} />

      {inOffLease && stages.length > 0 && (
        <>
          <h4 className={styles.sectionTitle}>Off-Lease Progress</h4>
          <div className={styles.progressRow}>
            {stages.flatMap((s, i) => {
              const card = <StageCard key={s.stage} stage={s} isCurrent={s.stage === currentStageNum} />;
              // The approval gate sits between Stage 1 and Stage 2 in the real workflow.
              if (i !== 0) return [card];
              return [card, <GateCard key="gate" status={approvalLower} date={approvalDate} user={approvalUser} />];
            })}
          </div>

          {filledStages.length > 0 && (
            <>
              <h4 className={styles.sectionTitle}>Filled Stage Data</h4>
              <div className={styles.filledStack}>
                {filledStages.map((s) => (
                  <div key={s.stage} className={styles.filledCard}>
                    <div className={styles.filledHeader}>
                      <span className={styles.filledBadge}>{s.displayStage ? `Stage ${s.displayStage}` : 'Retired'}</span>
                      <span className={styles.filledTitle}>{s.label}</span>
                      <span className={styles.filledStatus}>{s.skipped ? 'Skipped' : 'Completed'}</span>
                      <span className={styles.filledMeta}>
                        {formatActionTimestamp(s.timestamp)}{s.user ? ` · ${s.user}` : ''}
                      </span>
                    </div>
                    {/* Skipped means nothing actually happened at this stage —
                        the fields underneath it (repair verdict, remarks,
                        photos) describe the Gate-In event that routed AROUND
                        it, not an inspection that occurred here, so showing
                        them under "Skipped" reads as a completed checklist
                        that never happened. The status badge alone is the
                        whole story. */}
                    {!s.skipped && s.fields.length > 0 && (
                      <div className={styles.filledGrid}>
                        {s.fields.map((f) => (
                          <div key={f.label} className={styles.item}>
                            <span className={styles.label}>{f.label}</span>
                            <span className={styles.value}>{renderCellValue(f.value)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {!s.skipped && s.inspection?.length > 0 && (
                      <ChecklistTable title="Container Inspection Checklist" columnLabel="Instruction Point" points={s.inspection} />
                    )}
                    {!s.skipped && s.machine?.length > 0 && (
                      <ChecklistTable title="Machine Check" columnLabel="Machine Point" points={s.machine} />
                    )}
                    {!s.skipped && s.fields.length === 0 && !s.inspection?.length && !s.machine?.length && (
                      <p className={styles.filledEmpty}>No fields recorded for this stage.</p>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

/** Status word -> pill tone. Anything unrecognised stays neutral rather than
 *  being forced into a colour that would imply a state it isn't in. */
const HISTORY_TONE = {
  completed: 'histDone',
  approved: 'histDone',
  logged: 'histLogged',
  rejected: 'histRejected',
  pending: 'histPending',
  skipped: 'histNeutral'
};

function HistoryTable({ rows }) {
  return (
    <div className={styles.histWrap}>
      <table className={styles.histTable}>
        <thead>
          <tr>{HISTORY_HEAD.map((h) => <th key={h}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const tone = HISTORY_TONE[String(r.status).toLowerCase()];
            return (
              /* Index-keyed deliberately: Stage 9 contributes one row per
                 movement, so neither the stage name nor the date is unique. */
              <tr key={i} className={r.stage === 'Stage 9' ? styles.histMovementRow : undefined}>
                <td className={styles.histStage}>{r.stage}</td>
                <td>{r.name || '—'}</td>
                <td><span className={tone ? styles[tone] : styles.histNeutral}>{r.status}</span></td>
                <td>{r.on || '—'}</td>
                <td>{r.by || '—'}</td>
                <td className={styles.slaCell}>
                  {r.sla
                    ? <span className={r.sla.delayed ? styles.slaLate : styles.slaOk}>{slaText(r.sla)}</span>
                    : '—'}
                </td>
                <td>{r.detail || '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Invoice-wise outstanding, the same table Stage 1 shows and the same one the
 * PDF prints — all three read buildInvoices(), so they cannot disagree. Rows
 * come straight from the Accounts & Collection API in the order returned; the
 * attachment is joined on from the Billing Sales sheet.
 */
function InvoicesSection({ invoices }) {
  if (!invoices) return null;

  // Month, Amount and Age read as columns of figures, so they align like ones.
  const align = ['', '', styles.tCenter, styles.tRight, styles.tCenter, ''];

  return (
    <>
      <h4 className={styles.sectionTitle}>
        Invoices
        {invoices.party && <span className={styles.sectionCount}>{invoices.party}</span>}
      </h4>
      <div className={styles.histWrap}>
        <table className={styles.histTable}>
          <thead>
            <tr>{INVOICE_HEAD.map((h, i) => <th key={h} className={align[i]}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {invoices.rows.map((row, i) => (
              <tr key={i}>
                {row.map((cell, c) => (
                  <td key={c} className={`${align[c]} ${c === 0 ? styles.invNo : ''}`}>
                    {/* Last column is that invoice's own document URL. It is
                        kept as a raw string in the row so the Excel and PDF
                        exports carry the link; only the on-screen table turns
                        it into an icon. Empty means the invoice genuinely has
                        no file — shown as inert text, never another
                        invoice's link. */}
                    {c === INVOICE_HEAD.length - 1
                      ? (cell
                        ? (
                          <a
                            className={styles.invFileBtn}
                            href={cell}
                            target="_blank"
                            rel="noreferrer"
                            title={`Open invoice ${row[0]}`}
                            aria-label={`Open invoice ${row[0]}`}
                          >↗</a>
                        )
                        : <span className={styles.invNoFile}>No file</span>)
                      : renderCellValue(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className={styles.invTotalRow}>
              <td colSpan={3}>Grand Total</td>
              <td className={styles.tRight}>₹{invoices.grandTotal}</td>
              <td colSpan={2} />
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  );
}

/** Stage 9 in full — the history table above shows one line per movement, this
 *  shows every field each movement recorded. */
function MovementsSection({ movements, error }) {
  if (error) return <p className={styles.movementsError}>Stage 9 movements unavailable: {error}</p>;
  if (!movements) return null;

  return (
    <>
      <h4 className={styles.sectionTitle}>
        Stage 9 — Container Movements
        <span className={styles.sectionCount}>
          {movements.count} movement{movements.count === 1 ? '' : 's'}
        </span>
      </h4>
      <div className={styles.histWrap}>
        <table className={styles.histTable}>
          <thead>
            <tr>{MOVEMENT_HEAD.map((h) => <th key={h}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {movements.rows.map((row, i) => (
              <tr key={i}>{row.map((cell, c) => <td key={c}>{renderCellValue(cell)}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/**
 * A Stage 3 checklist table, as returned by the detail endpoint's
 * `stages[].inspection` / `stages[].machine`. Only points that were actually
 * filled in come back, and the Estimate/Photo/Remarks columns collapse away
 * entirely when nothing is damaged.
 */
function ChecklistTable({ title, columnLabel, points }) {
  const anyDamage = points.some((p) => String(p.status).toLowerCase() === 'damage');

  return (
    <div className={styles.inspWrap}>
      <p className={styles.inspTitle}>{title}</p>
      <table className={styles.inspTable}>
        <thead>
          <tr>
            <th>{columnLabel}</th>
            <th>Good / Damage</th>
            {anyDamage && <><th>Estimate</th><th>Photo</th><th>Remarks</th></>}
          </tr>
        </thead>
        <tbody>
          {points.map((p) => {
            const st = String(p.status).toLowerCase();
            const tone = st === 'damage' ? styles.inspDamage : st === 'good' ? styles.inspGood : styles.inspNA;
            return (
              <tr key={p.n}>
                <td><span className={styles.inspNum}>{p.n}.</span>{p.item}</td>
                <td>
                  <span className={tone}>{p.status || '—'}</span>
                </td>
                {anyDamage && (
                  <>
                    <td>{p.estimate || '—'}</td>
                    <td>{p.photo ? renderCellValue(p.photo) : '—'}</td>
                    <td>{p.remark || '—'}</td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function StageCard({ stage, isCurrent }) {
  const cls = stage.done ? styles.cardDone : (isCurrent ? styles.cardCurrent : styles.cardLocked);
  return (
    <div className={`${styles.stageCard} ${cls}`}>
      {/* displayStage is null for a retired stage — label it as such rather
          than showing a number that now belongs to a different stage. */}
      <span className={styles.stageCardLabel}>{stage.displayStage ? `Stage ${stage.displayStage}` : 'Retired'}</span>
      <span className={styles.stageCardTitle}>{stage.label}</span>
      <span className={styles.stageCardStatus}>{stage.skipped ? 'Skipped' : stage.done ? 'Completed' : 'Pending'}</span>
      {stage.done && (
        <span className={styles.stageCardMeta}>{formatActionTimestamp(stage.timestamp)}{stage.user ? ` · ${stage.user}` : ''}</span>
      )}
    </div>
  );
}

function GateCard({ status, date, user }) {
  const cls = status === 'approved' ? styles.cardDone : status === 'rejected' ? styles.cardRejected : styles.cardLocked;
  const label = status === 'approved' ? 'Approved' : status === 'rejected' ? 'Rejected' : 'Pending';
  return (
    <div className={`${styles.stageCard} ${styles.gateCard} ${cls}`}>
      <span className={styles.stageCardLabel}>{status === 'approved' ? '✓ Gate' : 'Gate'}</span>
      <span className={styles.stageCardTitle}>Intimation Approval</span>
      <span className={styles.stageCardStatus}>{label}</span>
      {status && status !== 'pending' && (
        <span className={styles.stageCardMeta}>{formatActionTimestamp(date)}{user ? ` · ${user}` : ''}</span>
      )}
    </div>
  );
}
