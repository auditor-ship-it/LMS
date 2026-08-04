import { useMemo, useState } from 'react';
import { StatCard, Card, Button, SearchBar, LoadingState, ErrorState, EmptyState } from '../../components/ui/index.js';
import { useAsync } from '../../hooks/useAsync.js';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import { fetchOffLeaseDashboard } from '../../services/offLease.service.js';
import { STAGES } from '../../constants/stages.js';
import styles from './PipelineDashboard.module.css';

const STAGE_ICONS = { 1: 'inbox', 2: 'container', 3: 'search', 4: 'edit', 5: 'list', 6: 'container', 7: 'check-circle', 8: 'lock' };

/**
 * Off-Lease pipeline overview — KPI counts + every active container's
 * current stage in one table, mirroring the "Pending Approval"/"Stage N"
 * tabs' data (GET /offlease/dashboard, offlease.service.js's
 * getOffLeaseDashboardData) rather than duplicating any write logic here.
 * Clicking "Open"/"Approve" jumps to the tab that actually owns the action —
 * this page is a map of where things are, not a new place to act on them.
 */
export function PipelineDashboard({ onOpenTab }) {
  const { data, loading, error, reload } = useAsync(fetchOffLeaseDashboard, []);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 200);

  const kpis = data?.kpis || {};
  const items = data?.items || [];

  const filtered = useMemo(() => {
    const term = debouncedSearch.trim().toLowerCase();
    if (!term) return items;
    return items.filter((it) =>
      it.container.toLowerCase().includes(term) ||
      it.clientName.toLowerCase().includes(term) ||
      it.leaseId.toLowerCase().includes(term));
  }, [items, debouncedSearch]);

  return (
    <>
      <div className={styles.kpiRow}>
        <StatCard icon="package" label="Active off-lease requests" value={kpis.active ?? '—'} tint="navy" />
        <StatCard
          icon="clock" label="Pending approval" value={kpis.pendingApproval ?? '—'} tint="warn"
          footnote={kpis.pendingApproval > 0 ? 'Needs sign-off' : undefined}
          onClick={() => onOpenTab?.('approval')}
        />
        {STAGES.map((s) => (
          <StatCard
            key={s.number}
            icon={STAGE_ICONS[s.number]}
            label={`Stage ${s.number} · ${s.label}`}
            value={kpis.byStage?.[s.number] ?? '—'}
            tint={s.number === 8 ? 'success' : 'info'}
            footnote={s.owner}
            onClick={() => onOpenTab?.(`stage${s.number}`)}
          />
        ))}
        <StatCard icon="check" label="Completed this month" value={kpis.completedThisMonth ?? '—'} tint="success" />
      </div>

      <Card
        title="Active off-lease pipeline"
        actions={<Button variant="secondary" size="sm" onClick={reload}>Refresh</Button>}
      >
        <div className={styles.toolbar}>
          <SearchBar value={search} onChange={setSearch} placeholder="Search container, client, lease ID…" />
        </div>

        {loading && <LoadingState label="Loading pipeline…" />}
        {!loading && error && <ErrorState message={error} onRetry={reload} />}
        {!loading && !error && filtered.length === 0 && (
          <EmptyState message="No active off-lease containers" hint={search ? 'Try a different search' : undefined} />
        )}

        {!loading && !error && filtered.length > 0 && (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Lease ID</th>
                  <th>Container</th>
                  <th>Client</th>
                  <th>Stage</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered.map((it) => (
                  <tr key={it.container}>
                    <td className={styles.leaseId}>{it.leaseId || '—'}</td>
                    <td className={styles.container}>{it.container}</td>
                    <td>{it.clientName || '—'}</td>
                    <td><MiniPipeline item={it} /></td>
                    <td className={styles.actionCell}>
                      {it.stageClass === 'approval' ? (
                        <Button size="sm" variant="primary" onClick={() => onOpenTab?.('approval')}>Approve</Button>
                      ) : it.stageClass === 'done' ? (
                        <span className={styles.doneTag}>Released</span>
                      ) : it.stageClass === 'rejected' ? (
                        <span className={styles.rejectedTag}>Rejected</span>
                      ) : (
                        <Button size="sm" variant="secondary" onClick={() => onOpenTab?.(`stage${it.currentStageNum}`)}>Open</Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

/**
 * A real connected step-tracker, not a row of colored badges: a dot per
 * stage (+ the approval gate between Stage 1 and 2), joined by a line that
 * fills in behind everything already done. No visible text — the table stays
 * single-line/dense (matches every other DataGrid in this app); each dot's
 * full stage name is available via title="" on hover.
 */
function MiniPipeline({ item }) {
  const { stages, approvalStatus, currentStageNum, stageClass } = item;
  const approvalLower = String(approvalStatus || '').trim().toLowerCase();

  const dotClass = (done, isCurrent, rejected) => [
    styles.dot,
    rejected ? styles.dotRejected : done ? styles.dotDone : isCurrent ? styles.dotCurrent : styles.dotFuture
  ].filter(Boolean).join(' ');

  const lineClass = (filled) => [styles.line, filled ? styles.lineDone : ''].filter(Boolean).join(' ');

  const nodes = [];
  stages.forEach((s, i) => {
    if (i !== 0) nodes.push(<span key={`l${s.stage}`} className={lineClass(stages[i - 1].done)} />);
    nodes.push(
      <span key={`s${s.stage}`} className={dotClass(s.done, s.stage === currentStageNum)} title={`Stage ${s.stage} · ${s.label}${s.done ? ' — Completed' : s.stage === currentStageNum ? ' — In progress' : ''}`} />
    );
    if (i === 0) {
      const gateDone = approvalLower === 'approved';
      const gateRejected = approvalLower === 'rejected';
      nodes.push(<span key="gl" className={lineClass(gateDone)} />);
      nodes.push(
        <span
          key="gate"
          className={dotClass(gateDone, stageClass === 'approval', gateRejected)}
          title={`Intimation Approval — ${gateRejected ? 'Rejected' : gateDone ? 'Approved' : 'Pending'}`}
        />
      );
    }
  });

  return <div className={styles.pipeline}>{nodes}</div>;
}
