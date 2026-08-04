import { renderCellValue } from '../../components/ui/CellValue.jsx';
import styles from './LookupResult.module.css';

const APPROVAL_LABEL = { approved: 'Approved', rejected: 'Rejected' };

/**
 * Container lookup result card — identity fields, an 8-stage progress board
 * (plus the Intimation Approval gate between Stage 1 and Stage 2), and a
 * "Filled Stage Data" section showing every field captured so far for each
 * completed stage. All of this data was already returned by
 * GET /offlease/:containerNo/detail (`stages[].fields`, `approvalStatus`,
 * etc.) — this is a rendering-only change, no backend/API change needed.
 * `rate` is deliberately NOT rendered here (system-wide convention: pricing
 * is hidden from every grid/detail view — see utils/isRateOrAmountHeader.js),
 * even though the API response includes it.
 */
export function LookupResult({ result }) {
  const {
    container, leaseId, size, type, clientCode, clientName, location,
    deployedDate, validUpto, orderNos, inOffLease, approvalStatus,
    approvalDate, approvalUser, stages = [], currentStage
  } = result;

  const identity = [
    ['Order No', orderNos],
    ['Lease ID', leaseId],
    ['Client Code', clientCode],
    ['Client Name', clientName],
    ['Size', size],
    ['Type', type],
    ['Location', location],
    ['Deployed Date', deployedDate],
    ['Valid Upto', validUpto]
    // Rate intentionally excluded from this view — see file header note.
  ];
  if (inOffLease && approvalStatus) {
    identity.push(['Approval Status', APPROVAL_LABEL[String(approvalStatus).toLowerCase()] || approvalStatus]);
    if (approvalDate) identity.push(['Approved / Rejected On', approvalDate]);
    if (approvalUser) identity.push(['Approved By', approvalUser]);
  }

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
                      <span className={styles.filledBadge}>Stage {s.stage}</span>
                      <span className={styles.filledTitle}>{s.label}</span>
                      <span className={styles.filledStatus}>Completed</span>
                      <span className={styles.filledMeta}>
                        {s.timestamp}{s.user ? ` · ${s.user}` : ''}
                      </span>
                    </div>
                    {s.fields.length > 0 ? (
                      <div className={styles.filledGrid}>
                        {s.fields.map((f) => (
                          <div key={f.label} className={styles.item}>
                            <span className={styles.label}>{f.label}</span>
                            <span className={styles.value}>{renderCellValue(f.value)}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
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

function StageCard({ stage, isCurrent }) {
  const cls = stage.done ? styles.cardDone : (isCurrent ? styles.cardCurrent : styles.cardLocked);
  return (
    <div className={`${styles.stageCard} ${cls}`}>
      <span className={styles.stageCardLabel}>Stage {stage.stage}</span>
      <span className={styles.stageCardTitle}>{stage.label}</span>
      <span className={styles.stageCardStatus}>{stage.done ? 'Completed' : 'Pending'}</span>
      {stage.done && (
        <span className={styles.stageCardMeta}>{stage.timestamp}{stage.user ? ` · ${stage.user}` : ''}</span>
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
        <span className={styles.stageCardMeta}>{date}{user ? ` · ${user}` : ''}</span>
      )}
    </div>
  );
}
