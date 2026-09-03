import { useState } from 'react';
import { Card, LoadingState, ErrorState, EmptyState, Modal } from '../../components/ui/index.js';
import { PageHeader } from '../../components/ui/PageHeader.jsx';
import { useAsync } from '../../hooks/useAsync.js';
import { usePolling } from '../../hooks/usePolling.js';
import { getOffLeaseEfficiencyData } from '../../api/offlease.api.js';
import styles from './OffLeaseEfficiencyPage.module.css';

/**
 * Off-Lease Efficiency — an analytical view over the whole pipeline, built
 * around ONE question: where are the gaps, and who owns them.
 *
 * Structure (per the 2026-09-02c trim — the per-container "Containers" table
 * and its owner/overdue-only filter bar were removed outright: the filters
 * existed ONLY to narrow that table, so once it was gone they filtered
 * nothing and stayed on screen as dead controls):
 *  1. Overall Efficiency — one blended ring across every stage combined.
 *  2. Stage pipeline — each stage's OVERDUE % (not on-time %; explicitly
 *     requested as the headline number). Click a stage to open its
 *     bottleneck drill-down: who/what (by client) is behind the delay, and
 *     for each of those, the full time-in-stage statistics (average,
 *     median, 90th percentile, worst case, overrun past target).
 *  3. Bottleneck table — one compact, ranked table (most overdue-in-progress
 *     first) naming the stage, its owner, and its numbers — sits directly
 *     under the chart so "who's causing the delay" is visible with zero
 *     scrolling.
 *
 * Read-only, backed by GET /offlease/efficiency (offleaseEfficiency.service.js).
 */
export function OffLeaseEfficiencyPage() {
  const { data, loading, error, reload } = useAsync(getOffLeaseEfficiencyData, []);
  usePolling(() => reload({ silent: true }));

  // Which stage's bottleneck drill-down modal is open; null = none.
  const [bottleneckStageNum, setBottleneckStageNum] = useState(null);

  const overall = data?.overall || null;
  const stages = data?.stages || [];
  const bottlenecks = data?.bottlenecks || [];
  const bottleneckStage = stages.find((s) => s.stage === bottleneckStageNum) || null;

  return (
    <>
      <PageHeader title="Off-Lease Efficiency" subtitle="Where the pipeline is falling behind, and who owns the gap" />

      {loading && <LoadingState />}
      {!loading && error && <ErrorState message={error} onRetry={reload} />}

      {!loading && !error && (
        <>
          {overall && (
            <Card title="Overall Efficiency" className={styles.card}>
              <p className={styles.sectionHint}>Blended overdue % across every stage combined.</p>
              <div className={styles.heroAll}>
                <span className={`${styles.heroRing} ${overall.overduePct != null ? overdueClass(overall.overduePct, styles) : styles.stepPctMuted}`}>
                  <span className={styles.heroPct}>{overall.overduePct != null ? `${overall.overduePct}%` : '—'}</span>
                  {overall.runningOverdueCount > 0 && <span className={styles.heroBadge}>{overall.runningOverdueCount}</span>}
                </span>
                <span className={styles.heroMeta}>
                  <span className={styles.heroLabel}>All Stages</span>
                  <span className={styles.heroSub}>
                    {overall.completedCount} completed &middot; {overall.runningCount} in progress
                    {overall.runningOverdueCount > 0 ? ` · ${overall.runningOverdueCount} overdue right now` : ''}
                  </span>
                </span>
              </div>
            </Card>
          )}

          <Card title="Stage-Wise Overdue %" className={styles.card}>
            <p className={styles.sectionHint}>
              Overdue instances (completed late, or currently sitting past budget) against everything that has been through that stage.
              Click a stage to see WHO/WHAT is behind the delay. Each stage's budget is its own historical median completion time — a
              stage with no completions yet (marked <em>no history</em>) falls back to a default 1h/2d budget until real data exists to calibrate from.
            </p>
            <StagePipeline stages={stages} onOpenBottlenecks={setBottleneckStageNum} />
          </Card>

          <StageBottleneckModal stage={bottleneckStage} onClose={() => setBottleneckStageNum(null)} />

          <Card title="Where Delays Are Happening" className={styles.card}>
            <p className={styles.sectionHint}>Ranked most overdue-in-progress first — the owner column names who to talk to.</p>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Stage</th>
                    <th>Owner</th>
                    <th>Overdue %</th>
                    <th>Overdue Now</th>
                    <th>Completed</th>
                    <th>Avg Turnaround</th>
                  </tr>
                </thead>
                <tbody>
                  {bottlenecks.map((b, i) => (
                    <tr key={b.stage}>
                      <td className={styles.mono}>{i + 1}</td>
                      <td className={styles.stageName}>{b.label}</td>
                      <td className={styles.owner}>{b.owner}</td>
                      <td>{b.overduePct != null ? <span className={overdueClass(b.overduePct, styles)}>{b.overduePct}%</span> : '—'}</td>
                      <td>
                        {b.runningOverdueCount > 0
                          ? <span className={styles.overdueTag}>{b.runningOverdueCount}</span>
                          : <span className={styles.mono}>0</span>}
                      </td>
                      <td className={styles.mono}>{b.completedCount}</td>
                      <td className={styles.mono}>{b.avgTurnaround || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!bottlenecks.length && <EmptyState message="No stage activity yet" />}
            </div>
          </Card>
        </>
      )}
    </>
  );
}

/** Overdue % reads the OPPOSITE direction from on-time % — high is bad here. */
function overdueClass(pct, styles) {
  if (pct <= 30) return styles.rateGood;
  if (pct <= 60) return styles.rateWarn;
  return styles.rateBad;
}

/** Stage-wise overdue % — each stage its own ring, colored by severity.
 *  Click a stage to open its bottleneck drill-down (StageBottleneckModal). */
function StagePipeline({ stages, onOpenBottlenecks }) {
  return (
    <div className={styles.stepper}>
      {stages.map((s, i) => (
        <span key={s.stage} className={styles.stepWrap}>
          {i > 0 && <span className={styles.stepLine} />}
          <button
            type="button"
            className={styles.step}
            title={s.budgetSource === 'auto'
              ? `${s.label} (${s.owner}) — ${s.completedCount} completed, budget ${s.budget} (median of ${s.budgetSampleSize} past completions)`
              : `${s.label} (${s.owner}) — ${s.completedCount} completed, budget ${s.budget} (default — no completions yet to calibrate from)`}
            onClick={() => onOpenBottlenecks(s.stage)}
          >
            <span className={`${styles.stepPct} ${s.overduePct != null ? overdueClass(s.overduePct, styles) : styles.stepPctMuted}`}>
              {s.overduePct != null ? `${s.overduePct}%` : '—'}
            </span>
            <span className={styles.stepLabel}>{s.label}</span>
            {s.budgetSource === 'default' && <span className={styles.stepNoHistory}>no history</span>}
            {s.runningOverdueCount > 0 && <span className={styles.stepBadge}>{s.runningOverdueCount}</span>}
          </button>
        </span>
      ))}
    </div>
  );
}

/**
 * Stage drill-down modal — matches a reference dashboard's "stage circle ->
 * bottleneck-by-contributor ranking -> per-contributor statistical detail"
 * pattern, explicit 2026-09-02 request. This app has one FIXED owner per
 * whole stage (not per job-order), so "bottlenecks" here are ranked by
 * CLIENT — whose containers are contributing the most cumulative overrun
 * (time PAST budget) at this stage — rather than by individual handler.
 * Two views in one modal, toggled by local state, same as the reference's
 * in-place "Back" navigation rather than stacking a second modal on top.
 */
function StageBottleneckModal({ stage, onClose }) {
  const [drill, setDrill] = useState(null);

  if (!stage) return null;

  return (
    <Modal
      open={!!stage}
      onClose={() => { setDrill(null); onClose(); }}
      title={drill ? `${stage.label} › ${drill.name}` : stage.label}
      width="620px"
    >
      {drill ? (
        <>
          <button type="button" className={styles.modalBack} onClick={() => setDrill(null)}>&larr; Back</button>
          <div className={styles.metricsLabel}>Metrics</div>
          <div className={styles.metricsList}>
            {[
              ['Average time in stage', drill.metrics.avgTime, drill.metrics.avgMs],
              ['Median time in stage', drill.metrics.medianTime, drill.metrics.medianMs],
              ['90th percentile time', drill.metrics.p90Time, drill.metrics.p90Ms],
              ['Worst case', drill.metrics.worstTime, drill.metrics.worstMs],
              ['Average overrun past target', drill.metrics.avgOverrun, drill.metrics.avgOverrunMs],
              ['Total overrun contributed', drill.metrics.totalOverrun, drill.metrics.totalOverrunMs]
            ].map(([label, display, ms]) => {
              const scale = drill.metrics.worstMs || ms || 1;
              const fillPct = ms != null ? Math.max(3, Math.round((ms / scale) * 100)) : 0;
              const targetPct = drill.metrics.targetMs != null ? Math.min(100, Math.round((drill.metrics.targetMs / scale) * 100)) : null;
              return (
                <div key={label} className={styles.metricRow}>
                  <div className={styles.metricRowHead}>
                    <span>{label}</span>
                    <span className={styles.metricRowValue}>
                      {display || '—'} <span className={styles.metricRowTarget}>/ {drill.metrics.target}</span>
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
            <span className={`${styles.modalRing} ${stage.overduePct != null ? overdueClass(stage.overduePct, styles) : styles.stepPctMuted}`}>
              <span className={styles.modalRingPct}>{stage.overduePct != null ? `${stage.overduePct}%` : '—'}</span>
            </span>
            <div className={styles.modalStats}>
              <div className={styles.modalStatRow}><span>Avg TAT / Target</span><span>{stage.avgTurnaround || '—'} / {stage.budget}</span></div>
              <div className={styles.modalStatRow}><span>Late</span><span>{stage.lateCount} of {stage.totalCount}</span></div>
              <div className={styles.modalStatRow}><span>Time lost</span><span>{stage.timeLost || '—'}</span></div>
            </div>
          </div>
          <div className={styles.metricsLabel}>Bottlenecks — by client</div>
          {!stage.bottlenecks.length && <p className={styles.sectionHint}>No late instances recorded for this stage yet.</p>}
          <div className={styles.bottleneckList}>
            {stage.bottlenecks.map((b) => (
              <button type="button" key={b.name} className={styles.bottleneckRow} onClick={() => setDrill(b)}>
                <div className={styles.bottleneckRowHead}>
                  <span className={styles.bottleneckName}>{b.name} <span className={styles.bottleneckRole}>client</span></span>
                  <span className={styles.bottleneckStat}>{b.lateCount} &middot; {b.totalOverrun}</span>
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
        </>
      )}
    </Modal>
  );
}
