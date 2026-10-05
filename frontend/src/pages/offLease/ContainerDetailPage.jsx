import { useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { LoadingState, ErrorState, Button } from '../../components/ui/index.js';
import { renderCellValue } from '../../components/ui/CellValue.jsx';
import { useAsync } from '../../hooks/useAsync.js';
import { lookupContainer, fetchRemarkThread } from '../../services/offLease.service.js';
import { formatActionTimestamp } from '../../utils/formatDateTime.js';
import { exportLookupToExcel, exportLookupToPdf } from './lookupExport.js';
import {
  FilledStageCard, EstimateSummaryTable, HistoryTable, InvoicesSection, MovementsSection, GateCard
} from './LookupResult.jsx';
import { useStageSelection, StageSelector } from './StageSelector.jsx';
import {
  buildHistoryRows, buildMovements, buildInvoices, buildEstimateTotals, APPROVAL_LABEL
} from './lookupModel.js';
import { getSdRefundsForContainer } from '../../api/stage.api.js';
import { ApprovalPanel } from './ApprovalPanel.jsx';
import { StageDetailModal } from '../stages/StageDetailModal.jsx';
import { isReadOnlyStage, ALL_STAGES } from '../../constants/stages.js';
import { usePermission } from '../../hooks/usePermission.js';
import { ROUTES } from '../../constants/routes.js';
import styles from './ContainerDetailPage.module.css';

/**
 * Full-page record view, opened from the Off-Lease dashboard at
 * /off-lease/record?container=&leaseId=. Layout follows the OMS order page:
 * identity header with progress, a summary strip, tabs, then a stage-card
 * overview beside a remarks / latest-activity rail.
 *
 * All data still comes from lookupContainer() and the shared builders in
 * lookupModel.js, so the Excel/PDF export, Container Lookup and this page
 * cannot disagree about which fields exist.
 *
 * KeepAlivePages keeps this mounted while hidden and the query string then
 * belongs to whichever page is current — so the last params seen while active
 * are remembered rather than read live.
 */
const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'history', label: 'History' },
  { key: 'stages', label: 'Stage data' },
  { key: 'invoices', label: 'Invoices' },
  { key: 'movements', label: 'Movements' }
];

/* Overview columns, keyed by the stage's internal number. Retired stages
   (2, 4, 10) have no entry and fall into Operations, where their completed
   data belongs historically. */
const COLUMNS = [
  { key: 'intimation', label: 'Intimation & Approval', tone: 'colBlue' },
  { key: 'ops', label: 'Operations', tone: 'colAmber' },
  { key: 'billing', label: 'Billing & Payment', tone: 'colGreen' }
];
const STAGE_COLUMN = { 1: 'intimation', 6: 'ops', 7: 'ops', 3: 'ops', 5: 'billing', 11: 'billing', 8: 'billing' };

const SD_REFUNDS_INTERNAL = 11;

export function ContainerDetailPage({ isActive }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const last = useRef({ container: '', leaseId: '', row: undefined });
  if (isActive && params.get('container')) {
    last.current = { container: params.get('container'), leaseId: params.get('leaseId') || '', row: Number(params.get('row')) || undefined };
  }
  const { container, leaseId, row } = last.current;
  const { canAct } = usePermission();
  // The stage whose form is open inline in place of the tabs, or null.
  const [stageForm, setStageForm] = useState(null);
  const [tab, setTab] = useState('overview');

  const { data, loading, error, reload } = useAsync(
    () => (container ? lookupContainer(container, leaseId || undefined) : Promise.resolve(null)),
    [container, leaseId]
  );
  const { data: remarks } = useAsync(
    () => (container ? fetchRemarkThread(container, leaseId || undefined) : Promise.resolve([])),
    [container, leaseId]
  );

  /* This record's SD Refund entry (newest for the lease) — its HOD / CEO
     decisions are what Stage 6A and 6B show. */
  const { data: refundEntries } = useAsync(
    () => (container ? getSdRefundsForContainer(container) : Promise.resolve([])),
    [container]
  );
  const refund = (refundEntries || []).find((e) => !leaseId || !e.offLeaseId || e.offLeaseId === leaseId) || null;

  const ready = data?.found && !data?.multiple;
  const { filled, selected, toggle } = useStageSelection(data);

  const back = (
    <button type="button" className={styles.back} onClick={() => navigate(ROUTES.OFF_LEASE)} aria-label="Back to Off-Lease">←</button>
  );

  if (!container) return <ErrorState message="No container selected" />;
  if (loading) return <LoadingState label="Loading stage data…" />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!ready) return <ErrorState message={data?.message || 'No off-lease record found for this container'} />;

  /* Name from the app's own stage table when the API sends none (an older
     backend build had no name for SD Refunds, which left the card untitled). */
  const stages = (data.stages || []).map((x) => (
    x.label ? x : { ...x, label: ALL_STAGES.find((a) => a.number === x.stage)?.label || '' }
  ));
  const doneCount = stages.filter((s) => s.done).length;
  const pct = stages.length ? Math.round((doneCount / stages.length) * 100) : 0;
  const approvalLower = String(data.approvalStatus || '').trim().toLowerCase();
  const filledStages = stages.filter((s) => s.done);
  const estimateTotals = buildEstimateTotals(data);
  const history = buildHistoryRows(data);
  const invoices = buildInvoices(data);
  const movements = buildMovements(data);
  /* Same rules as the dashboard's stage chips: only the current stage is
     editable (and only with permission); a done one is view-only; a future
     one is locked. */
  /* Stage 1 is submitted but the Intimation Approval gate (1A) hasn't passed:
     nothing after it can start — Stage 2 only opens once 1A is approved — so
     1A is the current step, not Stage 2. A rejection stops the chain the same
     way, with nothing current. */
  const stage1Done = !!stages.find((x) => x.stage === 1)?.done;
  const gateBlocking = stage1Done && approvalLower !== 'approved';
  const gatePending = gateBlocking && approvalLower !== 'rejected';
  const openStage = (s) => {
    const isCurrent = !gateBlocking && s.stage === stages.find((x) => !x.done)?.stage;
    if (!s.done && !isCurrent) return;
    const readOnlyType = isReadOnlyStage(s.stage);
    const canEditNow = !readOnlyType && isCurrent && canAct(`offlease${s.stage}`);
    setStageForm({
      stageNumber: s.stage,
      readOnly: !canEditNow,
      identityOnly: readOnlyType,
      label: s.label,
      display: s.displayStage,
      status: s.done ? 'Completed' : 'In progress'
    });
  };
  /* Once SD Refunds is submitted the record waits on HOD (6A), then CEO (6B),
     before Payment Status (7) can start — so while either is undecided THEY are
     the current step, not 7. A rejection stops the chain, so neither is. */
  const sdDone = stages.find((x) => x.stage === SD_REFUNDS_INTERNAL)?.done;
  const approvalCurrent = !(sdDone && refund) ? null
    : (refund.hodStatus === 'Rejected' || refund.ceoStatus === 'Rejected') ? null
      : refund.hodStatus !== 'Approved' ? '6a'
        : refund.ceoStatus !== 'Approved' ? '6b' : null;
  // The gate has no stage form; it opens the approval panel in the same place.
  const openGate = () => setStageForm({ gate: true, label: 'Intimation Approval', status: approvalLower === 'approved' ? 'Approved' : approvalLower === 'rejected' ? 'Rejected' : 'Pending approval' });
  const currentNum = (approvalCurrent || gateBlocking) ? null : stages.find((x) => !x.done)?.stage;
  /* Derived from the same stage list the cards and rail draw, not from the
     API's own `currentStage` string: that one is computed separately and could
     name a stage (e.g. Transportation) the cards already show as completed. */
  const currentLabel = (() => {
    if (data.stageClass && data.stageClass !== 'stage') return data.currentStage;
    if (approvalLower === 'rejected') return 'Rejected — container stays on lease';
    if (gatePending) return 'Pending Approval';
    if (approvalCurrent) return approvalCurrent === '6a' ? 'Stage 6A · HOD approval' : 'Stage 6B · CEO approval';
    const next = stages.find((x) => !x.done && x.displayStage);
    return next ? `Stage ${next.displayStage} · ${next.label}` : 'Completed — container released';
  })();
  const latest = history.filter((r) => r.on).slice(-4).reverse();

  return (
    <div className={styles.page}>
      <section className={styles.head}>
        <div className={styles.headTop}>
          {back}
          <div>
            <div className={styles.titleRow}>
              <h1 className={styles.title}>{data.container}</h1>
              {data.leaseId && <span className={styles.lease}>{data.leaseId}</span>}
              <span className={styles.livePill}>{currentLabel}</span>
            </div>
            <div className={styles.sub}>{data.clientName}{data.clientCode ? ` · ${data.clientCode}` : ''}</div>
          </div>
          <div className={styles.chips}>
            {(data.size || data.type) && <span className={styles.chip}>{[data.size, data.type].filter(Boolean).join(' ')}</span>}
            {data.location && <span className={styles.chip}>{data.location}</span>}
          </div>
          <div className={styles.progress}>
            <span className={styles.progressLabel}>Progress</span>
            <span className={styles.progressPct}>{pct}%</span>
            <span className={styles.bar}><i style={{ width: `${pct}%` }} /></span>
          </div>
        </div>

        <div className={styles.strip}>
          <Cell label="Client" value={data.clientName} sub={data.clientCode} />
          <Cell label="Stage" value={currentLabel} tone="stage" />
          <Cell label="Deployed" value={data.deployedDate} sub={data.orderNos ? `Order ${data.orderNos}` : ''} />
          <Cell label="Valid upto" value={data.validUpto} />
          <Cell
            label="Intimation approval"
            value={APPROVAL_LABEL[approvalLower] || (data.approvalStatus || 'Pending')}
            sub={data.approvalDate ? formatActionTimestamp(data.approvalDate) : ''}
          />
        </div>
      </section>

      {!stageForm && (
      <div className={styles.tabsBar}>
        <div className={styles.tabs} role="tablist">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              className={`${styles.tab} ${tab === t.key ? styles.tabOn : ''}`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className={styles.actions}>
          <StageSelector filled={filled} selected={selected} onToggle={toggle} />
          <Button variant="secondary" size="sm" onClick={() => exportLookupToExcel(data)}>Download Excel</Button>
          <Button variant="secondary" size="sm" onClick={() => exportLookupToPdf(data, selected)}>Download PDF</Button>
        </div>
      </div>
      )}

      <div className={styles.body}>
        <div className={styles.main}>
          {stageForm && (
            <>
              <button type="button" className={styles.backLink} onClick={() => setStageForm(null)}>← Back to record</button>
              <div className={styles.banner}>
                <span className={styles.bannerKicker}>
                  {stageForm.gate ? 'Stage 1A' : stageForm.display ? `Stage ${stageForm.display}` : 'Retired stage'} · {stageForm.status}
                </span>
                <span className={styles.bannerTitle}>{stageForm.label}</span>
              </div>
              {stageForm.gate ? (
                <ApprovalPanel
                  containerNo={container}
                  rowNum={data._rowNum || row}
                  status={approvalLower}
                  date={data.approvalDate}
                  user={data.approvalUser}
                  stage1Fields={stages.find((x) => x.stage === 1)?.fields}
                  canAct={canAct('offleaseapproval') && approvalLower !== 'approved' && approvalLower !== 'rejected'}
                  onDone={() => { setStageForm(null); reload(); }}
                />
              ) : (
              <StageDetailModal
                inline
                key={stageForm.stageNumber}
                stageNumber={stageForm.stageNumber}
                containerNo={container}
                rowNum={data._rowNum || row}
                readOnly={stageForm.readOnly}
                identityOnly={stageForm.identityOnly}
                onClose={() => setStageForm(null)}
                onSaved={() => { setStageForm(null); reload(); }}
              />
              )}
            </>
          )}
          {!stageForm && tab === 'overview' && (
            <section className={styles.panel}>
              <h3 className={styles.panelTitle}>Stage checklist</h3>
              <div className={styles.columns}>
                {COLUMNS.map((col) => {
                  const colStages = stages.filter((s) => (STAGE_COLUMN[s.stage] || 'ops') === col.key);
                  if (!colStages.length && col.key !== 'intimation') return null;
                  const done = colStages.filter((s) => s.done).length;
                  return (
                    <div key={col.key} className={`${styles.column} ${styles[col.tone]}`}>
                      <div className={styles.columnHead}>
                        <span>{col.label}</span>
                        <span className={styles.columnCount}>{done}/{colStages.length} done</span>
                      </div>
                      {colStages.flatMap((s) => {
                        const card = <OverviewCard key={s.stage} stage={s} isCurrent={s.stage === currentNum} onOpen={openStage} />;
                        if (s.stage !== SD_REFUNDS_INTERNAL) return [card];
                        return [
                          card,
                          <ApprovalCard key="6a" current={approvalCurrent === '6a'} id="stage-card-6a" label="Stage 6A" title="HOD approval" status={refund?.hodStatus} by={refund?.hodApprover} on={refund?.hodDate} remarks={refund?.hodRemarks} submitted={!!refund} />,
                          <ApprovalCard key="6b" current={approvalCurrent === '6b'} id="stage-card-6b" label="Stage 6B" title="CEO approval" status={refund?.ceoStatus} by={refund?.ceoApprover} on={refund?.ceoDate} remarks={refund?.ceoRemarks} submitted={!!refund} waiting={refund && refund.hodStatus !== 'Approved'} />
                        ];
                      })}
                      {col.key === 'intimation' && (
                        <div id="gate-card" className={styles.cardLink} role="button" tabIndex={0} onClick={openGate} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openGate(); } }}><GateCard status={approvalLower} date={data.approvalDate} user={data.approvalUser} /></div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {!stageForm && tab === 'history' && (
            <section className={styles.panel}>
              <h3 className={styles.panelTitle}>Container history</h3>
              <HistoryTable rows={history} />
            </section>
          )}

          {!stageForm && tab === 'stages' && (
            <section className={styles.panel}>
              <h3 className={styles.panelTitle}>Filled stage data</h3>
              {filledStages.length === 0 && <p className={styles.empty}>No stage has been completed yet.</p>}
              <div className={styles.stack}>
                {filledStages.flatMap((s) => {
                  const nodes = [];
                  if (estimateTotals && s.stage === 3) nodes.push(<EstimateSummaryTable key="est" totals={estimateTotals} />);
                  nodes.push(<FilledStageCard key={s.stage} stage={s} />);
                  return nodes;
                })}
              </div>
            </section>
          )}

          {!stageForm && tab === 'invoices' && (
            <section className={styles.panel}>
              {invoices ? <InvoicesSection invoices={invoices} /> : <p className={styles.empty}>No invoices for this record.</p>}
            </section>
          )}

          {!stageForm && tab === 'movements' && (
            <section className={styles.panel}>
              {movements || data.movementsError
                ? <MovementsSection movements={movements} error={data.movementsError} />
                : <p className={styles.empty}>This container has not been moved.</p>}
            </section>
          )}
        </div>

        <nav className={styles.stageRail} aria-label="Jump to stage">
          {stages.flatMap((s, i) => {
            const dot = (
              <button
                key={s.stage}
                type="button"
                title={s.label}
                className={`${styles.railDot} ${s.done ? styles.railDone : s.stage === currentNum ? styles.railCurrent : ''}`}
                onClick={() => openStage(s)}
              >
                {s.displayStage || 'R'}
              </button>
            );
            /* Stage 6A (HOD) / 6B (CEO) approve the SD Refund that Stage 6
               (internal 11) raises. They are queue approvals on the Off-Lease
               page, not per-record forms, so their dots just bring up the SD
               Refunds card. Shown only to those who can act on them, same as
               the Off-Lease tabs. */
            if (s.stage === SD_REFUNDS_INTERNAL) {
              const extra = [['6A', 'HOD', refund?.hodStatus], ['6B', 'CEO', refund?.ceoStatus]]
                .map(([label, who, status]) => (
                  <button
                    key={label}
                    type="button"
                    title={`Stage ${label} (${who}) — ${status || 'Pending'}`}
                    className={`${styles.railDot} ${status === 'Approved' ? styles.railDone : status === 'Rejected' ? styles.railRejected : approvalCurrent === label.toLowerCase() ? styles.railCurrent : ''}`}
                    onClick={() => {
                      setStageForm(null);
                      setTab('overview');
                      setTimeout(() => document.getElementById(`stage-card-${label.toLowerCase()}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 0);
                    }}
                  >
                    {label}
                  </button>
                ));
              return [dot, ...extra];
            }
            if (i !== 0) return [dot];
            /* The approval gate sits between the first and second stage, same
               as on the cards. It has no form, so its dot shows the Overview
               and scrolls to the gate card. */
            const gateTone = approvalLower === 'approved' ? styles.railDone : approvalLower === 'rejected' ? styles.railRejected : gatePending ? styles.railCurrent : '';
            return [dot, (
              <button
                key="gate"
                type="button"
                title="Intimation Approval"
                className={`${styles.railDot} ${gateTone}`}
                onClick={openGate}
              >
                1A
              </button>
            )];
          })}
        </nav>

        <aside className={styles.rail}>
          <section className={styles.panel}>
            <h3 className={styles.panelTitle}>Remarks · {remarks?.length ?? 0}</h3>
            {(remarks || []).slice(0, 5).map((r) => (
              <div key={r.id} className={styles.remark}>
                <span dangerouslySetInnerHTML={{ __html: r.html }} />
                <span className={styles.meta}>{[formatActionTimestamp(r.timestamp), r.enteredBy].filter(Boolean).join(' · ')}</span>
              </div>
            ))}
            {remarks?.length === 0 && <p className={styles.empty}>No remarks yet.</p>}
          </section>

          <section className={styles.panel}>
            <h3 className={styles.panelTitle}>Latest activity</h3>
            {latest.length === 0 && <p className={styles.empty}>Nothing recorded yet.</p>}
            {latest.map((r, i) => (
              <div key={i} className={styles.activity}>
                <span className={styles.dot} />
                <div>
                  <div className={styles.actTitle}>{r.stage} · {r.name}</div>
                  <div className={styles.meta}>{[r.on, r.by].filter(Boolean).join(' · ')}</div>
                </div>
              </div>
            ))}
          </section>
        </aside>
      </div>
    </div>
  );
}

function Cell({ label, value, sub, tone }) {
  return (
    <div className={`${styles.cell} ${tone === 'stage' ? styles.cellStage : ''}`}>
      <span className={styles.cellLabel}>{label}</span>
      <span className={styles.cellValue}>{value || '—'}</span>
      {sub ? <span className={styles.cellSub}>{sub}</span> : null}
    </div>
  );
}

/** One checklist-style card per stage: status, who/when, and a short field preview. */
function OverviewCard({ stage: s, isCurrent, onOpen }) {
  const clickable = s.done || isCurrent;
  const tone = s.done ? styles.cDone : isCurrent ? styles.cCurrent : styles.cLocked;
  const preview = (s.fields || []).slice(0, 4);
  return (
    <div
      id={`stage-card-${s.stage}`}
      className={`${styles.card} ${tone} ${clickable ? styles.cardLink : ''}`}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? () => onOpen(s) : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(s); } } : undefined}
    >
      <div className={styles.cardHead}>
        <span className={styles.cardNum}>{s.displayStage ? `Stage ${s.displayStage}` : 'Retired'}</span>
        <span className={styles.cardTitle}>{s.label}</span>
        <span className={styles.cardStatus}>{s.skipped ? 'Skipped' : s.done ? 'Completed' : isCurrent ? 'In progress' : 'Pending'}</span>
      </div>
      {s.done && (
        <div className={styles.meta}>{formatActionTimestamp(s.timestamp)}{s.user ? ` · ${s.user}` : ''}</div>
      )}
      {!s.skipped && preview.map((f) => (
        <div key={f.label} className={styles.row}>
          <span className={styles.rowLabel}>{f.label}</span>
          <span className={styles.rowValue}>{renderCellValue(f.value)}</span>
        </div>
      ))}
    </div>
  );
}

/** Stage 6A (HOD) / 6B (CEO): the approval decisions on this record's SD Refund.
 *  Read-only here — the deciding happens on the Off-Lease 6A / 6B tabs. */
function ApprovalCard({ id, label, title, status, by, on, remarks, submitted, waiting, current }) {
  const state = status === 'Approved' ? 'Approved' : status === 'Rejected' ? 'Rejected' : 'Pending';
  const tone = state === 'Approved' ? styles.cDone : state === 'Rejected' ? styles.cRejected : current ? styles.cCurrent : styles.cLocked;
  return (
    <div id={id} className={`${styles.card} ${tone}`}>
      <div className={styles.cardHead}>
        <span className={styles.cardNum}>{label}</span>
        <span className={styles.cardTitle}>{title}</span>
        <span className={styles.cardStatus}>{state}</span>
      </div>
      {!submitted && <div className={styles.meta}>No SD refund submitted yet.</div>}
      {submitted && state === 'Pending' && (
        <div className={styles.meta}>{waiting ? 'Waiting for HOD approval first.' : 'Awaiting decision.'}</div>
      )}
      {(by || on) && <div className={styles.meta}>{[on, by].filter(Boolean).join(' · ')}</div>}
      {remarks && (
        <div className={styles.row}>
          <span className={styles.rowLabel}>Remarks</span>
          <span className={styles.rowValue}>{remarks}</span>
        </div>
      )}
    </div>
  );
}
