import { useState, useMemo } from 'react';
import { Card, Button, LoadingState, ErrorState, EmptyState, Modal } from '../../components/ui/index.js';
import { PageHeader } from '../../components/ui/PageHeader.jsx';
import { useAsync } from '../../hooks/useAsync.js';
import { usePolling } from '../../hooks/usePolling.js';
import { useAutoRefresh } from '../../hooks/useAutoRefresh.js';
import { getOffLeaseEfficiencyData } from '../../api/offlease.api.js';
import { exportEfficiencyToPdf } from './efficiencyExport.js';
import { apiErrorMessage } from '../../shared/auth/index.js';
import styles from './OffLeaseEfficiencyPage.module.css';

/**
 * Off-Lease Efficiency — Target/Actual Efficiency % (see
 * offleaseEfficiency.service.js's own header comment for the full formula
 * and data-model notes). UI REWORKED 2026-09-04 to match a reference
 * dashboard's layout (hero ring + stage-ring row + stage-drill-down ->
 * client-bottleneck-list -> client-metrics-drill three-level flow) — same
 * visual pattern, this app's own real Target/Actual data throughout, not
 * the reference's numbers.
 *
 * Backed by GET /offlease/efficiency (offleaseEfficiency.service.js's
 * getOffLeaseEfficiencyReport) — the SAME endpoint the external "Company
 * Efficiency Dashboard" consumes via the public API-key route.
 */
export function OffLeaseEfficiencyPage() {
  const { data, loading, error, reload } = useAsync(getOffLeaseEfficiencyData, []);
  usePolling(() => reload({ silent: true }));
  useAutoRefresh('off-lease', () => reload({ silent: true }));

  const [drillStageNum, setDrillStageNum] = useState(null);
  const [drillContainer, setDrillContainer] = useState(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState('');

  /** Exports exactly what's on screen — same GET /offlease/efficiency
   *  payload this page itself renders, so the PDF can never show a number
   *  the dashboard didn't. */
  const handleDownloadPdf = () => {
    if (!data) return;
    setDownloadError('');
    setDownloading(true);
    try {
      exportEfficiencyToPdf(data);
    } catch (e) {
      setDownloadError(apiErrorMessage(e));
    } finally {
      setDownloading(false);
    }
  };

  const overall = data?.overall || null;
  const stages = data?.stages || [];
  const dataQuality = data?.dataQuality || null;
  const containers = data?.containers || [];
  const drillStage = stages.find((s) => s.stage === drillStageNum) || null;

  const sortedContainers = useMemo(
    () => [...containers].sort((a, b) => {
      const ea = a.cumulative?.cumulativeEfficiencyPercentage;
      const eb = b.cumulative?.cumulativeEfficiencyPercentage;
      if (ea == null && eb == null) return 0;
      if (ea == null) return 1;
      if (eb == null) return -1;
      return ea - eb;
    }),
    [containers]
  );

  return (
    <>
      <PageHeader
        title="Off-Lease Efficiency"
        subtitle="Target vs. Actual time — how the pipeline is performing against SOP, per stage and per container"
        actions={
          <Button variant="secondary" size="sm" loading={downloading} disabled={!data} onClick={handleDownloadPdf}>
            Download PDF
          </Button>
        }
      />
      {downloadError && <p className={styles.actionError}>{downloadError}</p>}

      {loading && <LoadingState />}
      {!loading && error && <ErrorState message={error} onRetry={reload} />}

      {!loading && !error && (
        <>
          {overall && (
            <Card className={styles.card}>
              <div className={styles.heroAll}>
                <span className={`${styles.heroRing} ${overall.cumulativeEfficiencyPercentage != null ? efficiencyClass(overall.cumulativeEfficiencyPercentage, styles) : styles.stepPctMuted}`}>
                  <span className={styles.heroPct}>{overall.cumulativeEfficiencyPercentage != null ? `${overall.cumulativeEfficiencyPercentage}%` : '—'}</span>
                </span>
                <div className={styles.heroMeta}>
                  <span className={styles.heroLabel}>Off-Lease</span>
                  <span className={styles.heroSub}>
                    target 100% &middot; {overall.totalCases.toLocaleString()} containers &middot; {overall.invalidDataCases.toLocaleString()} need data review
                  </span>
                  <span className={styles.heroChipRow}>
                    <span className={styles.heroChip}>{overall.onTimeRate != null ? `${overall.onTimeRate}%` : '—'} of stages on time</span>
                    <span className={styles.infoDot} title="Cumulative % = total target time ÷ total actual time across every completed stage. On-time % = share of completed stage instances that finished within their target, counted one-for-one.">i</span>
                  </span>
                </div>
              </div>
            </Card>
          )}

          <Card className={styles.card}>
            <div className={styles.sectionLabel}>STAGES EFFICIENCY</div>
            <div className={styles.stepper}>
              {stages.map((s, i) => (
                <span key={s.stage} className={styles.stepWrap}>
                  {i > 0 && <span className={styles.stepChevron}>&rsaquo;</span>}
                  <button
                    type="button"
                    className={styles.step}
                    disabled={!s.totalSeen}
                    onClick={() => setDrillStageNum(s.stage)}
                  >
                    <span className={`${styles.stepPct} ${s.efficiencyPercentage != null ? efficiencyClass(s.efficiencyPercentage, styles) : styles.stepPctMuted}`}>
                      {s.efficiencyPercentage != null ? `${s.efficiencyPercentage}%` : '—'}
                    </span>
                    <span className={styles.stepLabel}>{s.stageName}</span>
                    {s.belowTargetCount > 0
                      ? <span className={styles.stepBadgeLate}>{s.belowTargetCount} BELOW TARGET</span>
                      : s.totalSeen > 0 && <span className={styles.stepBadgeGood}>ON TARGET</span>}
                  </button>
                </span>
              ))}
            </div>
          </Card>

          <StageDrillModal stage={drillStage} onClose={() => setDrillStageNum(null)} />

          {dataQuality && (
            <Card title="Data Quality" className={styles.card}>
              <p className={styles.sectionHint}>
                What the {dataQuality.totalRecords} records behind these numbers actually look like.
              </p>
              <div className={styles.dqGrid}>
                <DqStat label="Valid" value={dataQuality.validEfficiencyRecords} tone="good" />
                <DqStat label="Needs review" value={dataQuality.recordsRequiringManualReview} tone="bad" />
                <DqStat label="Missing timestamps" value={dataQuality.missingTimestampRecords} tone="warn" />
                <DqStat label="Invalid timestamps" value={dataQuality.invalidTimestampRecords} tone="warn" />
                <DqStat label="Not applicable" value={dataQuality.notApplicableRecords} tone="mute" />
                <DqStat label="On hold" value={dataQuality.holdRecords} tone="mute" />
                <DqStat label="Rework detected" value={dataQuality.reworkRecords} tone="mute" />
              </div>
              {dataQuality.knownLimitations?.length > 0 && (
                <>
                  <div className={styles.metricsLabel} style={{ marginTop: 16 }}>Known data-model limitations</div>
                  <ul className={styles.limitList}>
                    {dataQuality.knownLimitations.map((l, i) => <li key={i}>{l}</li>)}
                  </ul>
                </>
              )}
            </Card>
          )}

          <Card title="Containers — Lowest Efficiency First" className={styles.card}>
            <p className={styles.sectionHint}>Click a row for the full target/actual breakdown, stage by stage.</p>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>#</th><th>Container</th><th>Client</th><th>Current Stage</th>
                    <th>Efficiency</th><th>Target</th><th>Actual</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedContainers.map((c, i) => (
                    <tr key={c.containerNo + c.leaseId} className={styles.clickableRow} onClick={() => setDrillContainer(c)}>
                      <td className={styles.mono}>{i + 1}</td>
                      <td className={styles.stageName}>{c.containerNo}</td>
                      <td>{c.clientName}</td>
                      <td>{c.currentStage}{c.hadRework && <span className={styles.reworkTag}>rework</span>}</td>
                      <td>{c.cumulative?.cumulativeEfficiencyPercentage != null
                        ? <span className={efficiencyClass(c.cumulative.cumulativeEfficiencyPercentage, styles)}>{c.cumulative.cumulativeEfficiencyPercentage}%</span>
                        : '—'}</td>
                      <td className={styles.mono}>{formatMinutes(c.cumulative?.totalTargetMinutes)}</td>
                      <td className={styles.mono}>{formatMinutes(c.cumulative?.totalActualMinutes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!sortedContainers.length && <EmptyState message="No containers yet" />}
            </div>
          </Card>

          <ContainerDrillModal container={drillContainer} onClose={() => setDrillContainer(null)} />
        </>
      )}
    </>
  );
}

function DqStat({ label, value, tone }) {
  return (
    <div className={styles.dqStat}>
      <span className={`${styles.dqStatValue} ${styles[`dqTone_${tone}`]}`}>{value}</span>
      <span className={styles.dqStatLabel}>{label}</span>
    </div>
  );
}

/** High is good here — Target/Actual efficiency, not the old Overdue %. */
function efficiencyClass(pct, styles) {
  if (pct >= 90) return styles.rateGood;
  if (pct >= 60) return styles.rateWarn;
  return styles.rateBad;
}

function formatMinutes(min) {
  if (min == null) return '—';
  const totalMin = Math.round(min);
  if (totalMin < 60) return `${totalMin}m`;
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/**
 * Stage drill-down — matches the reference's ring -> stat-row -> bottleneck-
 * by-client ranking -> per-client metrics pattern. This app has one FIXED
 * owner per whole stage (not per job-order, unlike the reference), so it's
 * shown once near the top rather than as a multi-chip "people responsible"
 * list at the bottom.
 */
function StageDrillModal({ stage, onClose }) {
  const [drillClient, setDrillClient] = useState(null);
  if (!stage) return null;

  return (
    <Modal open={!!stage} onClose={() => { setDrillClient(null); onClose(); }} title={drillClient ? `${stage.stageName} › ${drillClient.clientName}` : stage.stageName} width="640px">
      {drillClient ? (
        <>
          <button type="button" className={styles.modalBack} onClick={() => setDrillClient(null)}>&larr; Back</button>
          <div className={styles.metricsLabel}>Metrics</div>
          <div className={styles.metricsList}>
            {[
              ['Average time in stage', drillClient.avgActualDurationMinutes],
              ['Median time in stage', drillClient.medianActualDurationMinutes],
              ['90th percentile time', drillClient.p90ActualDurationMinutes],
              ['Worst case', drillClient.worstActualDurationMinutes],
              ['Average overrun past target', drillClient.avgOverrunMinutes],
              ['Total overrun contributed', drillClient.totalOverrunMinutes]
            ].map(([label, min]) => {
              const scale = drillClient.worstActualDurationMinutes || min || 1;
              const fillPct = min != null ? Math.max(3, Math.round((min / scale) * 100)) : 0;
              const targetPct = stage.targetDurationMinutes != null ? Math.min(100, Math.round((stage.targetDurationMinutes / scale) * 100)) : null;
              return (
                <div key={label} className={styles.metricRow}>
                  <div className={styles.metricRowHead}>
                    <span>{label}</span>
                    <span className={styles.metricRowValue}>
                      {formatMinutes(min)} <span className={styles.metricRowTarget}>/ {formatMinutes(stage.targetDurationMinutes)}</span>
                    </span>
                  </div>
                  <div className={styles.metricBarTrack}>
                    <div className={styles.metricBarFill} style={{ width: `${fillPct}%` }} />
                    {targetPct != null && <span className={styles.metricBarTarget} style={{ left: `${targetPct}%` }} />}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <>
          <div className={styles.modalHero}>
            <span className={`${styles.modalRing} ${stage.efficiencyPercentage != null ? efficiencyClass(stage.efficiencyPercentage, styles) : styles.stepPctMuted}`}>
              <span className={styles.modalRingPct}>{stage.efficiencyPercentage != null ? `${stage.efficiencyPercentage}%` : '—'}</span>
            </span>
            <div className={styles.modalStats}>
              <div className={styles.modalStatRow}><span>Owner</span><span>{stage.owner}</span></div>
              <div className={styles.modalStatRow}><span>Avg Actual / Target</span><span>{formatMinutes(stage.avgActualDurationMinutes)} / {formatMinutes(stage.targetDurationMinutes)}</span></div>
              <div className={styles.modalStatRow}><span>Below target</span><span>{stage.belowTargetCount} of {stage.totalSeen}</span></div>
              <div className={styles.modalStatRow}><span>Time lost</span><span>{formatMinutes(stage.timeLostMinutes)}</span></div>
            </div>
          </div>
          <div className={styles.metricsLabel}>Bottlenecks — by client</div>
          {!stage.bottlenecks.length && <p className={styles.sectionHint}>No below-target instances recorded for this stage yet.</p>}
          <div className={styles.bottleneckList}>
            {stage.bottlenecks.map((b) => (
              <button type="button" key={b.clientName} className={styles.bottleneckRow} onClick={() => setDrillClient(b)}>
                <div className={styles.bottleneckRowHead}>
                  <span className={styles.bottleneckName}>{b.clientName} <span className={styles.bottleneckRole}>client</span></span>
                  <span className={styles.bottleneckStat}>{b.belowTargetCount} &middot; {formatMinutes(b.totalOverrunMinutes)}</span>
                </div>
                <div className={styles.bottleneckBarRow}>
                  <div className={styles.bottleneckBarTrack}>
                    <div className={styles.bottleneckBarFill} style={{ width: `${Math.max(2, b.contributionPct)}%` }} />
                  </div>
                  <span className={styles.bottleneckPct}>{b.contributionPct}%</span>
                </div>
              </button>
            ))}
          </div>
          <div className={styles.metricsLabel} style={{ marginTop: 16 }}>Owner Responsible</div>
          <div className={styles.peopleRow}>
            <span className={styles.personChip}>{stage.owner}</span>
          </div>
        </>
      )}
    </Modal>
  );
}

const STATUS_LABEL = {
  COMPLETED: 'Completed', IN_PROGRESS: 'In Progress', HOLD: 'On Hold', NOT_STARTED: 'Not Started',
  NOT_APPLICABLE: 'Not Applicable', REJECTED: 'Rejected'
};

function statusClass(s, styles) {
  if (s.calculationStatus === 'MISSING_DATA' || s.calculationStatus === 'INVALID_DATA') return styles.pillBad;
  if (s.status === 'COMPLETED') return styles.pillGood;
  if (s.status === 'HOLD') return styles.pillWarn;
  if (s.status === 'IN_PROGRESS') return styles.pillAccent;
  return styles.pillMute;
}

/** Per-container drill-down — the full per-stage formula breakdown for one
 *  specific container, distinct from the stage-level bottleneck modal above. */
function ContainerDrillModal({ container, onClose }) {
  if (!container) return null;
  return (
    <Modal open={!!container} onClose={onClose} title={`${container.containerNo} — ${container.clientName}`} width="640px">
      <div className={styles.modalHero}>
        <span className={`${styles.modalRing} ${container.cumulative?.cumulativeEfficiencyPercentage != null ? efficiencyClass(container.cumulative.cumulativeEfficiencyPercentage, styles) : styles.stepPctMuted}`}>
          <span className={styles.modalRingPct}>{container.cumulative?.cumulativeEfficiencyPercentage != null ? `${container.cumulative.cumulativeEfficiencyPercentage}%` : '—'}</span>
        </span>
        <div className={styles.modalStats}>
          <div className={styles.modalStatRow}><span>Current stage</span><span>{container.currentStage}</span></div>
          <div className={styles.modalStatRow}><span>Target / Actual</span><span>{formatMinutes(container.cumulative?.totalTargetMinutes)} / {formatMinutes(container.cumulative?.totalActualMinutes)}</span></div>
          <div className={styles.modalStatRow}><span>Rework detected</span><span>{container.hadRework ? 'Yes (Move-To-Stage history)' : 'No'}</span></div>
        </div>
      </div>
      <div className={styles.metricsLabel}>Stage-by-stage</div>
      <div className={styles.stageDrillList}>
        {container.stages.map((s) => (
          <div key={s.stage} className={styles.stageDrillRow}>
            <div className={styles.stageDrillHead}>
              <span className={styles.stageDrillName}>{s.stageName}</span>
              <span className={`${styles.statusPill} ${statusClass(s, styles)}`}>
                {s.calculationStatus === 'MISSING_DATA' ? 'Missing Data'
                  : s.calculationStatus === 'INVALID_DATA' ? 'Invalid Data'
                  : (STATUS_LABEL[s.status] || s.status)}
              </span>
              {s.efficiencyPercentage != null && (
                <span className={efficiencyClass(s.efficiencyPercentage, styles)}>{s.efficiencyPercentage}%</span>
              )}
            </div>
            {s.formula && <div className={styles.stageDrillFormula}>{s.formula}</div>}
            {s.reason && <div className={styles.stageDrillReason}>{s.reason}</div>}
            {s.dataLimitation && <div className={styles.stageDrillReason}>{s.dataLimitation}</div>}
          </div>
        ))}
      </div>
    </Modal>
  );
}
