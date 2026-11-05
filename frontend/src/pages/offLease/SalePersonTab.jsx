import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Modal, StatCard, SearchBar, ErrorState, EmptyState } from '../../components/ui/index.js';
import { SkeletonCards } from '../../components/ui/Skeleton.jsx';
import { useAsync } from '../../hooks/useAsync.js';
import { usePolling } from '../../hooks/usePolling.js';
import { useAutoRefresh } from '../../hooks/useAutoRefresh.js';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import { usePermission } from '../../hooks/usePermission.js';
import { fetchOffLeaseDashboard } from '../../services/offLease.service.js';
import { fetchRefunds } from '../../services/refunds.service.js';
import { getOffLeaseTatReport } from '../../api/offlease.api.js';
import { ROUTES } from '../../constants/routes.js';
import { OrderBookView, ChipStrip, matchRefundAndTat } from './OrderBookView.jsx';
import { Highlight } from './Highlight.jsx';
import { Button } from '../../components/ui/index.js';
import pdStyles from './PipelineDashboard.module.css';
import styles from './SalePersonTab.module.css';

const UNASSIGNED = 'Unassigned';

/* Same two presentations PipelineDashboard.jsx's own Dashboard tab offers —
   explicit follow-up 2026-11-05 ("view 1 same tabe to view 2", then "this
   table replace same this table show for view 2"): this popup only had
   View 1 (the order-book cards) at first; View 2 (the compact table) is
   added here too, reusing PipelineDashboard's own CSS module (pdStyles) and
   OrderBookView's ChipStrip — the same real 1/1A/2/.../6A/6B/6C/7 chips
   View 1 shows — so it looks identical, not a re-styled copy. */
const VIEWS = [
  { key: 'book', label: 'View 1' },
  { key: 'table', label: 'View 2' }
];

/**
 * "Sale Person wise" tab — explicit request 2026-11-05 ("add the tab sale
 * and one pop sale person i am click the show unke offlease data"), then
 * ("show same this data this is not for sale person" — the first version's
 * plain table wasn't the real order-book view): the popup now renders the
 * SAME OrderBookView card list (remarks, TAT/delay, stage chips) the main
 * Dashboard tab uses, just filtered to one salesperson's own records,
 * instead of a stripped-down table. Fetches refundRows/tatRecords the exact
 * same way PipelineDashboard.jsx does — OrderBookView needs both to render
 * its SD Refund sub-chips and TAT/delay line correctly.
 *
 * `salePerson` on each item is resolved server-side in
 * getOffLeaseDashboardData (Sales CRM's assignedTo, keyed by Client Name —
 * read-only, same resolver every other "who owns this client" read in this
 * app uses) — no separate endpoint here, just grouping the same dashboard
 * fetch PipelineDashboard.jsx already has. A blank salePerson (no CRM match)
 * groups under "Unassigned", sorted last, same convention the Reports
 * page's own Sale Person summary table already uses.
 */
export function SalePersonTab({ onOpenTab }) {
  const navigate = useNavigate();
  const { canAct } = usePermission();
  const { data, loading, error, reload } = useAsync(fetchOffLeaseDashboard, []);
  usePolling(() => reload({ silent: true }));
  useAutoRefresh('off-lease', () => reload({ silent: true }));

  // Same two extra fetches OrderBookView needs on the main Dashboard tab —
  // see PipelineDashboard.jsx's own identical setup.
  const canSeeRefundApprovals = canAct('refundsApprovalHod') || canAct('refundsApprovalAccounts') || canAct('refundsApprovalCeo');
  const { data: refundsData, reload: reloadRefunds } = useAsync(
    () => (canSeeRefundApprovals ? fetchRefunds() : Promise.resolve({ data: [] })),
    [canSeeRefundApprovals]
  );
  usePolling(() => reloadRefunds({ silent: true }));
  const refundRows = refundsData?.data || [];
  const { data: tatData } = useAsync(() => getOffLeaseTatReport(), []);
  const tatRecords = tatData?.records || [];

  const openRecord = (rec) => {
    const q = new URLSearchParams({ container: rec.container });
    if (rec.leaseId) q.set('leaseId', rec.leaseId);
    if (rec._rowNum) q.set('row', String(rec._rowNum));
    navigate(`${ROUTES.OFF_LEASE_RECORD}?${q}`);
  };

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 200);
  const [openPerson, setOpenPerson] = useState(null);
  const [popupView, setPopupView] = useState('book');

  const items = data?.items || [];

  // Same ChipStrip matching PipelineDashboard.jsx's View 2 table uses —
  // scoped to just the open person's own records.
  const fmsMatch = useMemo(
    () => matchRefundAndTat(openPerson?.items || [], refundRows, tatRecords),
    [openPerson, refundRows, tatRecords]
  );

  const groups = useMemo(() => {
    const byPerson = new Map();
    for (const it of items) {
      const name = (it.salePerson || '').trim() || UNASSIGNED;
      if (!byPerson.has(name)) byPerson.set(name, []);
      byPerson.get(name).push(it);
    }
    const term = debouncedSearch.trim().toLowerCase();
    const out = [...byPerson.entries()]
      .map(([name, list]) => ({ name, items: list }))
      .filter((g) => !term || g.name.toLowerCase().includes(term));
    // Unassigned always last, everyone else by count descending — same
    // "biggest workload first" ordering the Reports page's own summary uses.
    out.sort((a, b) => {
      if (a.name === UNASSIGNED) return 1;
      if (b.name === UNASSIGNED) return -1;
      return b.items.length - a.items.length;
    });
    return out;
  }, [items, debouncedSearch]);

  return (
    <Card title="Off-Lease by Sale Person">
      <div className={styles.toolbar}>
        <SearchBar value={search} onChange={setSearch} placeholder="Search salesperson…" />
      </div>

      {error && <ErrorState message={error} onRetry={reload} />}
      {!error && loading && <SkeletonCards count={6} />}
      {!error && !loading && groups.length === 0 && <EmptyState message="No off-lease records found" />}

      {!error && !loading && groups.length > 0 && (
        <div className={styles.grid}>
          {groups.map((g) => (
            <StatCard
              key={g.name}
              size="sm"
              icon={g.name === UNASSIGNED ? 'info' : 'inbox'}
              label={g.name}
              value={g.items.length}
              tint={g.name === UNASSIGNED ? 'neutral' : 'info'}
              onClick={() => setOpenPerson(g)}
            />
          ))}
        </div>
      )}

      <Modal
        open={!!openPerson}
        onClose={() => setOpenPerson(null)}
        title={openPerson ? `${openPerson.name} — ${openPerson.items.length} off-lease record${openPerson.items.length === 1 ? '' : 's'}` : ''}
        width="min(1100px, 92vw)"
      >
        {openPerson && (
          <div className={styles.popupBody}>
            <div className={pdStyles.viewRow} style={{ marginBottom: 10 }}>
              {VIEWS.map((v) => (
                <button
                  key={v.key}
                  type="button"
                  className={`${pdStyles.viewTab} ${popupView === v.key ? pdStyles.viewTabActive : ''}`}
                  onClick={() => setPopupView(v.key)}
                >
                  {v.label}
                </button>
              ))}
            </div>

            {popupView === 'book' && (
              <OrderBookView
                items={openPerson.items}
                loading={false}
                error={null}
                onRetry={reload}
                refundRows={refundRows}
                tatRecords={tatRecords}
                onOpenRecord={openRecord}
                onOpenTab={(tabKey) => { setOpenPerson(null); onOpenTab?.(tabKey); }}
                onStageSaved={reload}
                searching={false}
              />
            )}

            {popupView === 'table' && (
              <div className={pdStyles.tableWrap}>
                <table className={pdStyles.table}>
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
                    {openPerson.items.map((it, i) => {
                      const { refundEntry, tatRecord } = fmsMatch.get(it) || {};
                      return (
                      <tr key={`${it.leaseId || i}-${it.container}`}>
                        <td className={pdStyles.leaseId}><Highlight text={it.leaseId || '—'} query="" /></td>
                        <td className={pdStyles.container}><Highlight text={it.container} query="" /></td>
                        <td>{it.clientName || '—'}</td>
                        <td><ChipStrip item={it} refundEntry={refundEntry} tatRecord={tatRecord} /></td>
                        <td className={pdStyles.actionCell}>
                          {it.stageClass === 'approval' ? (
                            <Button size="sm" variant="primary" onClick={() => { setOpenPerson(null); onOpenTab?.('approval'); }}>Approve</Button>
                          ) : it.stageClass === 'done' ? (
                            <span className={pdStyles.doneTag}>Released</span>
                          ) : it.stageClass === 'rejected' ? (
                            <span className={pdStyles.rejectedTag}>Rejected</span>
                          ) : (
                            <Button size="sm" variant="secondary" onClick={() => { setOpenPerson(null); onOpenTab?.(`stage${it.currentStageNum}`); }}>Open</Button>
                          )}
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </Modal>
    </Card>
  );
}
