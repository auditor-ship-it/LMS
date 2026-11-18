import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { StatCard, Card, Button, SearchBar, FilterBar, ErrorState, EmptyState } from '../../components/ui/index.js';
import { SkeletonTable } from '../../components/ui/Skeleton.jsx';
import { useAsync } from '../../hooks/useAsync.js';
import { usePolling } from '../../hooks/usePolling.js';
import { useAutoRefresh } from '../../hooks/useAutoRefresh.js';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import { fetchOffLeaseDashboard } from '../../services/offLease.service.js';
import { fetchMyTasks } from '../../services/myTask.service.js';
import { fetchRefunds } from '../../services/refunds.service.js';
import { getOffLeaseTatReport } from '../../api/offlease.api.js';
import { usePermission } from '../../hooks/usePermission.js';
import { STAGES } from '../../constants/stages.js';
import { ROUTES } from '../../constants/routes.js';
import { toDate } from '../../utils/formatDateTime.js';
import { apiErrorMessage } from '../../shared/auth/index.js';
import { submitStage } from '../../services/stage.service.js';
import { uploadStageFile } from '../../services/upload.service.js';
import { settleSequentially, describeBulkFailures } from '../../utils/bulkRenewalSubmit.js';
import { STAGE_FIELDS } from '../stages/stageFields.js';
import { BulkStage5Modal } from '../stages/BulkStage5Modal.jsx';
import { Highlight } from './Highlight.jsx';
import { OrderBookView, matchRefundAndTat, statusOf, currentTatStage } from './OrderBookView.jsx';
import { BulkRefundModal } from './BulkRefundModal.jsx';
import styles from './PipelineDashboard.module.css';

/** Internal stage number driving the "SD Refunds" KPI card/filter — same key
 *  STAGE_GROUPS' own group 3 uses. Bulk-select only makes sense scoped to
 *  this stage's own form (see BulkRefundModal). */
const SD_REFUNDS_STAGE_KEY = 11;
/** Same idea, for "Final Billing" — explicit request 2026-11-14 ("stage 5
 *  mai multiple slect ka option nahi hai"): the checkbox column and bulk bar
 *  also activate under this filter, driving BulkStage5Modal instead of the
 *  SD Refund one. */
const FINAL_BILLING_STAGE_KEY = 5;

const STAGE_ICONS = { 1: 'inbox', 2: 'container', 3: 'search', 4: 'edit', 5: 'list', 6: 'container', 7: 'check-circle', 8: 'lock', 11: 'inbox' };

/* View 2's own "With" column — explicit request 2026-11-18 (reference
 * screenshot showing a dark order-tracker table with "With: Logistics B /
 * Trans" / "QA B" columns, "mere data ke according bana, jo mere data mai
 * hai wese" — build it off THIS app's own real data, not invented fields).
 * statusOf's own `tab` already distinguishes every stage AND the SD Refund
 * sub-stages precisely — these owner names are the exact same literals the
 * KPI cards above already show as each card's own footnote (StatCard
 * `footnote` props elsewhere in this file); kept in one place here so both
 * stay in sync by construction rather than by two people remembering to
 * update two spots. 'stage${N}' keys mirror statusOf's own tab format. */
const OWNER_BY_TAB = {
  stage1: 'Christopher', approval: 'Pushpalata', stage6: 'Kshirod Khatua',
  stage7: 'Nikhil', stage3: 'Sitaram', stage5: 'Shivani', stage11: 'Christopher',
  sdRefundsHod: 'Pushpalata', sdRefundsAccounts: 'Shivani', sdRefundsCeo: 'Akash Sir',
  stage8: 'FMS Done'
};

/** Plain text from a remark's stored HTML (RichTextEditor output) — same
 *  "Main hold-up" column, one line, no markup. */
function stripHtml(html) {
  if (!html) return '';
  const div = document.createElement('div');
  div.innerHTML = html;
  return (div.textContent || '').trim();
}

/** "Main hold-up" — the record's own running remark (RemarkCell's data,
 *  already bulk-loaded on every dashboard item) when there is one; the Sent
 *  Back note when there isn't but this record has one; otherwise just the
 *  current stage's own name, so the column is never blank even for a record
 *  nobody has written anything about yet. Real data only — no invented
 *  "hold-up reason" field exists in Off-Lease, unlike the reference table's
 *  own app. */
function holdUpFor(it, status) {
  const remark = stripHtml(it.remarkHtml);
  if (remark) return remark;
  const stage1 = it.stages?.find((s) => s.stage === 1);
  if (!stage1?.done && stage1?.remark) return stage1.remark;
  return status.label;
}

/* The fixed per-stage TAT budget (target, not a computed average) — mirrors
   offLeaseTatTracking.service.js's own TAT_BUDGETS_MS exactly (1 Day / 3
   Hours / 7 Days / ... — see that file's own spec comment), shown on the
   TAT Tracking page's own Stage/TAT reference table. Explicit follow-up
   2026-11-05 ("not avg tat time... this add and dirct count", pointing at
   that exact table): the group scorecards below should sum THESE fixed
   targets, not an average computed from real completed records (which can
   be sparse/noisy, or simply absent for a group nothing has finished yet).
   A plain constant here, not fetched — these values don't change per
   request, same reasoning TAT_KEY_BY_INTERNAL is duplicated in
   OrderBookView.jsx rather than round-tripped from the backend. */
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const TAT_BUDGETS_MS = {
  '1': 1 * DAY, '1A': 3 * HOUR, '2': 7 * DAY,
  '3': 2 * HOUR, '4': 3 * HOUR, '5': 3 * HOUR,
  '6': 3 * DAY, '6A': 2 * HOUR, '6B': 2 * HOUR, '6C': 2 * HOUR,
  '7': 4 * DAY
};

/* Explicit request 2026-11-05 ("NEW SCORCRAD FOR DIFFIEND STAGE 1 INTIMATION
   TO TRANSPORT... STAGE 2 PICK UP INSEPCETION TO BILLING... STAGE THREE
   STAGE SD REFUNDS"): three rolled-up summary cards on top of the existing
   granular per-stage row below — each one groups several of those stages'
   own `stageFilter` keys (see toggleFilter/matchesStageKey) under one
   number and one click target, for a reader who wants the 3-phase shape of
   the pipeline rather than reading all 11+ individual cards. The granular
   row stays exactly as it was; this is additive, not a replacement. */
/* tatKeys: this group's own TAT_KEY_BY_INTERNAL-equivalent sequence
   (OrderBookView.jsx's own mapping — 1->'1', approval gate->'1A', 6
   (Transportation)->'2', 7 (Gate In)->'3', 3 (Inspection)->'4', 5 (Final
   Billing)->'5', 11 (SD Refunds)->'6', hod/accounts/ceo->'6A'/'6B'/'6C'),
   in pipeline order first to last — used below to compute each group's own
   average completed TAT (entry into the first stage to actual completion of
   the last one actually reached, per offLeaseTatTracking.service.js's own
   per-stage entryAt/actualAt). */
/* tint: explicit follow-up 2026-11-05 ("different color") — the 3 cards all
   read as one indistinguishable blue block otherwise; one distinct, non-
   status tint per group (StatCard.module.css's own palette — navy/amber/
   approval are the three already used elsewhere for plain categorization,
   not success/warn/error, which carry a done/bad meaning these groups don't
   have). */
const STAGE_GROUPS = {
  1: { label: 'Stage 1 · Intimation to Transportation', icon: 'inbox', keys: [1, 'approval', 6], tatKeys: ['1', '1A', '2'], tint: 'navy' },
  2: { label: 'Stage 2 · Inspection to Billing', icon: 'list', keys: [7, 3, 5], tatKeys: ['3', '4', '5'], tint: 'amber' },
  3: { label: 'Stage 3 · SD Refunds', icon: 'check-circle', keys: [11, 'hod', 'accounts', 'ceo'], tatKeys: ['6', '6A', '6B', '6C'], tint: 'approval' }
};

/**
 * Off-Lease pipeline overview — KPI counts + every active container's
 * current stage in one table, mirroring the "Pending Approval"/"Stage N"
 * tabs' data (GET /offlease/dashboard, offlease.service.js's
 * getOffLeaseDashboardData) rather than duplicating any write logic here.
 * Clicking "Open"/"Approve" jumps to the tab that actually owns the action —
 * this page is a map of where things are, not a new place to act on them.
 */
/* Two presentations of the SAME /offlease/dashboard response — View 1 reads
   like an order book (one block per record, pipeline as a chip strip), View 2
   is the compact table. Neither refetches when you switch; the choice is
   presentation only. */
const VIEWS = [
  { key: 'book', label: 'View 1' },
  { key: 'table', label: 'View 2' }
];

/** ms -> "Xd Yh", same style this app's own delayLabel strings already use
 *  (offLeaseTatTracking.service.js) — no existing frontend formatter for a
 *  plain duration, so a small one-off here rather than reusing a backend
 *  string built for a single record's delay. */
function formatDurationMs(ms) {
  const totalHours = Math.round(ms / 3600000);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  // Drops a zero unit (a single budget value is always clean days-only or
  // hours-only — see TAT_BUDGETS_MS — so "0d 3h" would just be noise); a
  // summed total that genuinely spans both keeps both.
  if (days && hours) return `${days}d ${hours}h`;
  if (days) return `${days}d`;
  return `${hours}h`;
}

/* Record fields the dashboard search looks through. */
const SEARCH_FIELDS = [
  'container', 'leaseId', 'clientName', 'clientCode', 'location', 'size', 'type',
  'raisedBy', 'deployedDate', 'validUpto', 'intimationDate'
];

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** "YYYY-MM" — sorts correctly as a plain string, which a "Month Year" label doesn't. */
const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

export function PipelineDashboard({ onOpenTab }) {
  const navigate = useNavigate();
  const { canAct } = usePermission();
  const { data, loading, error, reload } = useAsync(fetchOffLeaseDashboard, []);
  // Same background-eligibility catch as StagePageBase — see usePolling's doc comment.
  usePolling(() => reload({ silent: true }));
  useAutoRefresh('off-lease', () => reload({ silent: true }));
  /* Lease Expiry's own overdue count — same source the sidebar badge reads
     (getMyTasks -> .expired), fetched here too so the scorecard never shows
     a different number than the nav item right next to it. */
  const { data: taskCounts, loading: taskCountsLoading, reload: reloadTaskCounts } = useAsync(fetchMyTasks, []);
  usePolling(() => reloadTaskCounts({ silent: true }));
  /* Stage 6A (HOD) / 6B (Accounts) / 6C (CEO) scorecards — explicit request
     2026-10-05, reworked 2026-10-07 to insert Accounts and make CEO
     conditional on amount. SD Refunds is a separate backend system entirely
     (own sheet, own currentStage field — see refunds.service.js's own header
     comment), so this is its own fetch, not part of kpis.byStage above. Only
     fetched at all if the caller can act on at least one of the three, same
     gate the cards themselves use below. */
  const canSeeRefundApprovals = canAct('refundsApprovalHod') || canAct('refundsApprovalAccounts') || canAct('refundsApprovalCeo');
  const { data: refundsData, reload: reloadRefunds } = useAsync(
    () => (canSeeRefundApprovals ? fetchRefunds() : Promise.resolve({ data: [] })),
    [canSeeRefundApprovals]
  );
  usePolling(() => reloadRefunds({ silent: true }));
  const refundRows = refundsData?.data || [];
  const hodPendingCount = refundRows.filter((r) => r.currentStage === 'hod').length;
  const accountsPendingCount = refundRows.filter((r) => r.currentStage === 'accounts').length;
  const ceoPendingCount = refundRows.filter((r) => r.currentStage === 'ceo').length;
  /* Entry/Delay per stage, shown in each chip's hover tooltip — explicit
     request 2026-11-04 ("now this is stage show stage wise entry stage and
     show dely only"): same engine the TAT Tracking page and Container
     History use (offLeaseTatTracking.service.js), fetched once here (no
     container filter = every record) rather than re-deriving the
     computation in the frontend. Not gated behind a permission, same as the
     chips themselves. */
  const { data: tatData } = useAsync(() => getOffLeaseTatReport(), []);
  const tatRecords = tatData?.records || [];
  const [search, setSearch] = useState('');
  const [view, setView] = useState('book');
  // Opens the record's full stage history on its own page (not a modal).
  // `viewMode` ('phases') is passed ONLY from View 2's row click below — View
  // 1's own cards (onOpenRecord={openRecord}, one arg) leave it undefined, so
  // they keep landing on the original Overview layout, unchanged. See
  // ContainerDetailPage.jsx's PHASES doc comment for the other half of this.
  const openRecord = (rec, viewMode) => {
    const q = new URLSearchParams({ container: rec.container });
    if (rec.leaseId) q.set('leaseId', rec.leaseId);
    if (rec._rowNum) q.set('row', String(rec._rowNum));
    if (viewMode) q.set('view', viewMode);
    navigate(`${ROUTES.OFF_LEASE_RECORD}?${q}`);
  };
  /* null = no filter; otherwise one internal stage number, 'approval' or
     'done' — single-select. Was briefly multi-select (explicit request
     2026-11-10), REVERTED 2026-11-13 (explicit request, "filter multiple
     select nahi hona chahiye hai" — back to one filter at a time). */
  const [stageFilter, setStageFilter] = useState(null);
  /* null, or a STAGE_GROUPS key (1/2/3) — mutually exclusive with stageFilter
     (see toggleFilter/toggleGroupFilter, both clear the other). */
  const [groupFilter, setGroupFilter] = useState(null);
  /* '' = every month; otherwise a "YYYY-MM" key (monthKey) — explicit request
     2026-09-23, grouped on `intimationDate` (Off-Lease Intimation Date — when
     the request was actually raised). BUG FOUND AND FIXED the same day: this
     first shipped grouped on "OL Date" instead, which is a forward-looking
     TARGET completion date entered on Stage 1's own form (same value as that
     record's own Final Billing Date) — a record raised in September could
     show up under "October" simply because that's the date someone typed as
     its target finish, which is what a live record confirmed. Intimation
     Date only ever moves forward in step with "when did this actually
     happen", never a planned future date. */
  const [monthFilter, setMonthFilter] = useState('');
  // '' = everyone; a real salesperson name, or the literal 'Unassigned'.
  const [salePersonFilter, setSalePersonFilter] = useState('');
  const debouncedSearch = useDebouncedValue(search, 200);
  /* Rows checked for the bulk SD Refund form — keyed the same way the table
     rows are (`${leaseId||i}-${container}`). Cleared on a successful submit
     and whenever the SD Refunds filter is turned off, since the checkbox
     column itself only shows while that filter is active. */
  const [selectedKeys, setSelectedKeys] = useState(new Set());
  const [bulkRefundOpen, setBulkRefundOpen] = useState(false);
  const [bulkStage5Open, setBulkStage5Open] = useState(false);
  const [bulkStage5Busy, setBulkStage5Busy] = useState(false);
  const [bulkStage5Error, setBulkStage5Error] = useState('');
  const showSelectCol = stageFilter === SD_REFUNDS_STAGE_KEY || stageFilter === FINAL_BILLING_STAGE_KEY;
  useEffect(() => { if (!showSelectCol) setSelectedKeys(new Set()); }, [showSelectCol]);

  const kpis = data?.kpis || {};
  const items = data?.items || [];

  /* Every month that actually has a record, newest first — built from the
     live data rather than hand-listed, so a new month appears on its own the
     moment the first record lands in it, and a record with a genuinely blank
     intimationDate is simply not offered as a filter (it can still be found
     via search/other filters, just not grouped into "no date" as if that
     were a real month). */
  const monthOptions = useMemo(() => {
    const seen = new Map(); // "YYYY-MM" -> label
    for (const it of items) {
      const d = toDate(it.intimationDate);
      if (!d) continue;
      const key = monthKey(d);
      if (!seen.has(key)) seen.set(key, `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`);
    }
    return [...seen.entries()]
      .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
      .map(([value, label]) => ({ value, label }));
  }, [items]);

  /* Explicit request 2026-11-05 ("filter sale person") — a Sale Person
     filter on the main Dashboard toolbar itself, alongside Month, rather
     than only reachable via the separate Sale Person tab's own popup.
     `salePerson` is resolved server-side in getOffLeaseDashboardData (same
     Sales CRM lookup every other "who owns this client" read in this app
     uses) — built from whatever names are actually present in `items`, not
     a hand-maintained list, same reasoning monthOptions above uses. A blank
     salePerson groups under "Unassigned", sorted last, same convention
     SalePersonTab.jsx's own grouping already uses. */
  const UNASSIGNED = 'Unassigned';
  const salePersonOptions = useMemo(() => {
    const names = new Set();
    let hasUnassigned = false;
    for (const it of items) {
      const name = (it.salePerson || '').trim();
      if (name) names.add(name); else hasUnassigned = true;
    }
    const out = [...names].sort().map((n) => ({ value: n, label: n }));
    if (hasUnassigned) out.push({ value: UNASSIGNED, label: UNASSIGNED });
    return out;
  }, [items]);

  /* One predicate per stageFilter "key" (an internal stage number, 'approval',
     'done', 'hold', or 'hod'/'accounts'/'ceo') — extracted 2026-11-05 so the
     3 new STAGE_GROUPS cards below can OR several keys together instead of
     duplicating this matching logic. Behavior unchanged from before the
     extraction; see the per-branch comments that used to sit inline here for
     the full reasoning (pendingStages vs currentStageNum; the hod/accounts/
     ceo composite-key fix for a container with two off-lease rows). */
  /* BUG FOUND AND FIXED 2026-11-17 ("one pending par data nahi show kar raha
   * hai" — the Stage 6B card read 1, but the filtered list under it showed
   * 0 records): a bulk "Fill one SD Refund form for all" submission
   * (BulkRefundModal) writes ONE Offlease Bills row covering SEVERAL
   * containers — Container No and Off-Lease ID both land as one comma/
   * newline-joined cell (e.g. "TRIU6681671,MYRU4519115\nGESU9563904\n
   * SZLU9915829"), exactly like every other multi-container cell in this
   * app (see backend's own splitContainers, same [,;\n]+ convention). This
   * block was comparing that WHOLE joined string against one container's
   * own plain number — never equal, so a bulk-submitted row's own
   * containers could never match here, no matter how many were on it.
   * Single-container rows (the overwhelming majority) were never affected —
   * splitting a string with no separator just returns the same one string.
   */
  const splitMulti = (raw) => String(raw || '').split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);
  const refundWaitingSets = useMemo(() => {
    const sets = {};
    for (const stage of ['hod', 'accounts', 'ceo']) {
      const matching = refundRows.filter((r) => r.currentStage === stage);
      const composite = new Set();
      const containerOnly = new Set();
      for (const r of matching) {
        const containers = splitMulti(r.containerNo);
        const leaseIds = splitMulti(r.offLeaseId);
        containers.forEach((c, i) => {
          const cUpper = c.toUpperCase();
          containerOnly.add(cUpper);
          // Paired positionally — container i's own Off-Lease ID is leaseIds[i].
          // A row with fewer lease IDs than containers (data drift) still gets
          // every container into containerOnly; it just has no composite key.
          if (leaseIds[i]) composite.add(`${cUpper}|${leaseIds[i].toUpperCase()}`);
        });
      }
      sets[stage] = { composite, containerOnly };
    }
    return sets;
  }, [refundRows]);
  const itemsByContainerCount = useMemo(() => {
    const m = new Map();
    for (const it of items) {
      const c = String(it.container || '').trim().toUpperCase();
      if (c) m.set(c, (m.get(c) || 0) + 1);
    }
    return m;
  }, [items]);
  const matchesStageKey = (it, key) => {
    if (key === 'approval') return it.stageClass === 'approval';
    if (key === 'done') return it.stageClass === 'done';
    if (key === 'hold') return !!it.onHold;
    // "Stage 4.5 · Billing Send Back" — see that StatCard's own doc comment.
    const isBillingSendBack = !!it.billingSendBackNote && it.currentStageNum === 1;
    if (key === 'billingSendBack') return isBillingSendBack;
    /* Explicit follow-up 2026-11-18 ("stage 1 mai fir stage 5 ke send back
       nahi dikhne chahiye hai"): now that Billing Send Back has its own card
       above, the plain Stage 1 card/list must not ALSO show the same
       records — they'd double-count across the two cards, and a reader
       filtering "Stage 1" would see the "⚠ Final Billing Send Back" badge
       mixed in right after being told that has its own dedicated place.
       Scoped to key === 1 specifically (not pendingStages generally) so
       nothing else that reads pendingStages elsewhere is affected. */
    if (key === 1 && isBillingSendBack) return false;
    if (key === 'hod' || key === 'accounts' || key === 'ceo') {
      const { composite, containerOnly } = refundWaitingSets[key];
      const container = String(it.container || '').trim().toUpperCase();
      const leaseId = String(it.leaseId || '').trim().toUpperCase();
      if (leaseId && composite.has(`${container}|${leaseId}`)) return true;
      return itemsByContainerCount.get(container) === 1 && containerOnly.has(container);
    }
    return !!it.pendingStages?.includes(key);
  };

  /* Clicking a KPI card filters this dashboard rather than jumping to that
     stage's tab. The cards describe THIS list, so sending the reader somewhere
     else to see what they just counted loses the context they were building. */
  const filtered = useMemo(() => {
    const term = debouncedSearch.trim().toLowerCase();
    let out = items;

    if (groupFilter != null) {
      const keys = STAGE_GROUPS[groupFilter].keys;
      out = out.filter((it) => keys.some((k) => matchesStageKey(it, k)));
    } else if (stageFilter != null) {
      out = out.filter((it) => matchesStageKey(it, stageFilter));
    }

    if (monthFilter) {
      out = out.filter((it) => {
        const d = toDate(it.intimationDate);
        return d && monthKey(d) === monthFilter;
      });
    }

    if (salePersonFilter) {
      out = out.filter((it) => (it.salePerson || '').trim() === salePersonFilter
        || (!it.salePerson?.trim() && salePersonFilter === UNASSIGNED));
    }

    if (!term) return out;
    /* Every space-separated word must match somewhere in the record, in any
       order ("draeger vasai", "hnku 6063239", "reefer dahanu"). Matches the
       fields shown on the row, not just container / client / lease. */
    const words = term.split(/s+/).filter(Boolean);
    return out.filter((it) => {
      const hay = SEARCH_FIELDS.map((k) => String(it[k] ?? '')).join(' ').toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, debouncedSearch, stageFilter, groupFilter, monthFilter, salePersonFilter, refundWaitingSets, itemsByContainerCount]);

  /* View 2's own Status/Delay/Main hold-up columns need each row's matched
     refundEntry/tatRecord (statusOf/currentTatStage both take one) —
     OrderBookView.jsx's own exported matchRefundAndTat does the same
     composite container+Lease-ID matching that component's internal
     useMemos use, just standalone. (View 2 showed the full chip strip here
     too until 2026-11-18 — explicit request to drop it once the Status
     column already said the one thing that mattered, "where is it
     pending".) */
  const fmsMatch = useMemo(() => matchRefundAndTat(filtered, refundRows, tatRecords), [filtered, refundRows, tatRecords]);

  /* Group totals for the 3 STAGE_GROUPS cards — a distinct count of items
     matching ANY of the group's keys (not a naive sum of the individual
     per-stage counts, which would double-count a container pending in more
     than one of the group's own stages at once — same reasoning pendingStages
     already requires for a single stage, see matchesStageKey above). Always
     computed off the raw `items`, not `filtered`, so a card's own number never
     reacts to search/month/the OTHER filter being active — same convention
     the individual kpis.byStage cards already follow. */
  const groupTotals = useMemo(() => {
    const out = {};
    for (const [gk, group] of Object.entries(STAGE_GROUPS)) {
      out[gk] = items.filter((it) => group.keys.some((k) => matchesStageKey(it, k))).length;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, refundWaitingSets, itemsByContainerCount]);

  /* Second follow-up, same day ("not avg tat time, this add and dirct
     count", pointing at the TAT Tracking page's own Stage/TAT budget table):
     dropped the computed-average approach entirely (both the single-span
     version and the per-stage-average version that came before this) — a
     group's TAT line is now just the fixed TAT_BUDGETS_MS target for each
     of its own tatKeys, summed directly. Always available (never "no data
     yet"), and matches the exact reference numbers already shown elsewhere
     in this app (1 Day / 3 Hours / 7 Days / ...). */
  const groupTat = useMemo(() => {
    const out = {};
    for (const [gk, group] of Object.entries(STAGE_GROUPS)) {
      const perStage = group.tatKeys.map((tatKey) => ({ tatKey, budgetMs: TAT_BUDGETS_MS[tatKey] || 0 }));
      out[gk] = { totalMs: perStage.reduce((sum, p) => sum + p.budgetMs, 0), perStage };
    }
    return out;
  }, []);

  /* Clicking the active card again clears it — the same control that applied
     the filter removes it, so there is no hunting for a reset. Group and
     single-stage filters are mutually exclusive — picking one clears the
     other, so there's only ever one active filter to reason about/clear. */
  const toggleFilter = (key) => {
    setGroupFilter(null);
    setStageFilter((cur) => (cur === key ? null : key));
  };
  const toggleGroupFilter = (key) => { setStageFilter(null); setGroupFilter((cur) => (cur === key ? null : key)); };
  const toggleRowSelected = (key) => {
    setSelectedKeys((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };
  /* Same row-key shape OrderBookView.jsx's own row `key` already uses
     (`${leaseId||''}-${container}`) — shared so a container checked in View
     1 stays checked after switching to View 2 and back. */
  const selectedEntries = filtered
    .map((it) => ({ key: `${it.leaseId || ''}-${it.container}`, it }))
    .filter(({ key }) => selectedKeys.has(key))
    .map(({ it }) => ({ container: it.container, clientName: it.clientName, leaseId: it.leaseId, rowNum: it._rowNum }));

  /* Fill Stage 5 (Final Billing) once, submit it to every selected
   * container's own row — explicit request 2026-11-14. Files are uploaded
   * once (shared across every submission, same convention the Stage 5 queue
   * page's own bulk-fill handler uses), then settleSequentially submits one
   * at a time so the shared Google Sheets write-burst quota isn't tripped by
   * firing them all in parallel. */
  const handleBulkStage5Submit = async ({ values, pendingFiles }) => {
    setBulkStage5Busy(true);
    setBulkStage5Error('');
    try {
      const fileKeys = Object.keys(pendingFiles);
      const uploaded = {};
      for (const key of fileKeys) uploaded[key] = await uploadStageFile(pendingFiles[key]);
      const payload = { ...values, ...uploaded };
      const results = await settleSequentially(selectedEntries, (en) => submitStage(en.container, 5, payload, en.rowNum));
      const failures = describeBulkFailures(results, selectedEntries.map((en) => ({ row: [en.container] })), 'submitted', apiErrorMessage);
      if (failures) {
        setBulkStage5Error(failures);
        return;
      }
      setSelectedKeys(new Set());
      setBulkStage5Open(false);
      reload();
    } catch (e) {
      setBulkStage5Error(apiErrorMessage(e));
    } finally {
      setBulkStage5Busy(false);
    }
  };
  const stageKeyLabel = (key) => (
    key === 'approval' ? 'Pending approval'
      : key === 'done' ? 'Completed'
        : key === 'hold' ? 'On hold'
          : key === 'billingSendBack' ? 'Stage 4.5 · Billing Send Back'
          : key === 'hod' ? 'Stage 6A · HOD approval pending'
            : key === 'accounts' ? 'Stage 6B · Accounts approval pending'
              : key === 'ceo' ? 'Stage 6C · CEO approval pending'
                : (STAGES.find((s) => s.number === key)?.label || `Stage ${key}`)
  );
  const filterLabel = groupFilter != null
    ? STAGE_GROUPS[groupFilter].label
    : stageFilter != null ? stageKeyLabel(stageFilter) : '';

  return (
    <>
      <div className={styles.kpiPrimary}>
        {/* Fixed order per explicit request, 2026-09-04: Lease Expiry, Hold,
            Active, then the live workflow in sequence (Intimation ->
            Approval -> Transportation -> Gate In -> Inspection -> Final
            Billing), Completed last. Outstanding Payment card removed
            2026-09-29 (explicit request). Stage 6
            (KAM) is intentionally not in this row — everything else here is
            either a cross-module count or one explicit stage, not the
            generic STAGES.flatMap sweep this row used before. A real
            internal stage 10 ("LR & Return Transportation") lived here as
            "Stage 3" between Transportation and Gate In from 2026-09-18 to
            2026-09-22 (explicit request each time) — removed from the
            workflow entirely now, its KPI card gone with it, and every
            stage from Gate In onward shifted its display number back down
            by one. */}
        {/* Reverted to individual cards, 2026-09-04 — the combined split
            card read worse than two plain ones. Lease Expiry leads the row,
            navigating to that page (same destination the sidebar's own nav
            item goes to); Active Off-Lease keeps its own separate card. A
            plain client-side sum of the two — no backend change needed,
            both numbers are already loaded on this page. */}
        <StatCard size="lg"
          icon="grid" label="Total · Lease Expiry + Off-Lease"
          value={(taskCounts?.expired != null && kpis.active != null) ? taskCounts.expired + kpis.active : '—'}
          loading={loading || taskCountsLoading}
          tint="neutral"
        />
        <StatCard size="lg"
          icon="clock" label="Lease Expiry" value={taskCounts?.expired ?? '—'} loading={taskCountsLoading} tint="warn"
          footnote={taskCounts?.expired > 0 ? 'Overdue' : undefined}
          onClick={() => navigate(ROUTES.LEASE_EXPIRY)}
        />
        <StatCard size="lg" icon="package" label="Active off-lease requests" value={kpis.active ?? '—'} loading={loading} tint="navy" />
      </div>

      {/* Three rolled-up phase cards — see STAGE_GROUPS' own doc comment. */}
      <div className={styles.kpiGroups}>
        {Object.entries(STAGE_GROUPS).map(([gk, group]) => {
          const gt = groupTat[gk];
          // "S1 2d3h + 1A 0d5h + S2 1d2h" — short per-stage tag (numeric
          // tatKey -> "S<n>", a gate key like '1A'/'6C' shown as-is, already
          // reads as a stage).
          const breakdown = gt.perStage
            .map((p) => `${/^\d+$/.test(p.tatKey) ? `S${p.tatKey}` : p.tatKey} ${formatDurationMs(p.budgetMs)}`)
            .join(' + ');
          return (
            <StatCard size="xs" key={gk}
              icon={group.icon} label={group.label} value={groupTotals[gk] ?? '—'} loading={loading}
              footnote={`TAT Budget ${formatDurationMs(gt.totalMs)} = ${breakdown}`}
              tint={group.tint} active={groupFilter === Number(gk)} onClick={() => toggleGroupFilter(Number(gk))}
            />
          );
        })}
      </div>

      {/* One compact row for the per-stage counts; scrolls sideways rather
          than wrapping on a narrow window. */}
      <div className={styles.kpiStages}>
        <StatCard size="sm"
          icon="lock" label="Hold · Stage 1" value={kpis.holdStage1 ?? '—'} loading={loading} tint="hold"
          footnote={kpis.holdStage1 > 0 ? 'Paused' : undefined}
          active={stageFilter === 'hold'} onClick={() => toggleFilter('hold')}
        />
        <StatCard size="sm"
          icon={STAGE_ICONS[1]} label="Stage 1 · Off-Lease Intimation"
          value={kpis.byStage?.[1] != null ? kpis.byStage[1] - (kpis.billingSendBackPending ?? 0) : '—'}
          loading={loading} tint="info"
          footnote={STAGES.find((s) => s.number === 1)?.owner}
          active={stageFilter === 1} onClick={() => toggleFilter(1)}
        />
        <StatCard size="sm"
          icon="clock" label="Stage 1A · Approval" value={kpis.pendingApproval ?? '—'} loading={loading} tint="approval"
          footnote="Pushpalata"
          active={stageFilter === 'approval'} onClick={() => toggleFilter('approval')}
        />
        <StatCard size="sm"
          icon={STAGE_ICONS[6]} label="Stage 2 · Transportation" value={kpis.byStage?.[6] ?? '—'} loading={loading} tint="info"
          footnote={STAGES.find((s) => s.number === 6)?.owner}
          active={stageFilter === 6} onClick={() => toggleFilter(6)}
        />
        <StatCard size="sm"
          icon={STAGE_ICONS[7]} label="Stage 3 · Gate In" value={kpis.byStage?.[7] ?? '—'} loading={loading} tint="info"
          footnote={STAGES.find((s) => s.number === 7)?.owner}
          active={stageFilter === 7} onClick={() => toggleFilter(7)}
        />
        <StatCard size="sm"
          icon={STAGE_ICONS[3]} label="Stage 4 · Inspection Checklist" value={kpis.byStage?.[3] ?? '—'} loading={loading} tint="info"
          footnote={STAGES.find((s) => s.number === 3)?.owner}
          active={stageFilter === 3} onClick={() => toggleFilter(3)}
        />
        {/* Explicit request 2026-11-18 ("yah dono ek bich mai ek stage add
            karo 4.5 billing send back... stage 1 ke form ka edit kar ke waps
            send kare"): NOT a real new pipeline stage — these records are
            genuinely still at Stage 1, same form, same owner, same column
            data. This is a second, overlapping way to find the subset of
            Stage 1's own queue that's sitting there specifically because
            Final Billing sent it back for a correction, rather than a fresh
            intimation — which the plain "Stage 1" card's 38 buries almost
            entirely (20 of its 38 are these, confirmed live 2026-11-18).
            Stage 1's own card/count is deliberately untouched. */}
        <StatCard size="sm"
          icon="refresh" label="Stage 4.5 · Billing Send Back" value={kpis.billingSendBackPending ?? '—'} loading={loading} tint="hold"
          footnote={STAGES.find((s) => s.number === 1)?.owner}
          active={stageFilter === 'billingSendBack'} onClick={() => toggleFilter('billingSendBack')}
        />
        <StatCard size="sm"
          icon={STAGE_ICONS[5]} label="Stage 5 · Final Billing" value={kpis.byStage?.[5] ?? '—'} loading={loading} tint="info"
          footnote={STAGES.find((s) => s.number === 5)?.owner}
          active={stageFilter === 5} onClick={() => toggleFilter(5)}
        />
        {/* ADDED 2026-10-01 (explicit request: "add the stage 6 SD refunds")
            — internal stage 11, inserted before FMS Closed (internal 8,
            card just below, relabeled from "Stage 6" to "Stage 7" the same
            day). No footnote: no `owner` is set for this stage in stages.js
            (its status is set automatically, not by a named person). */}
        <StatCard size="sm"
          icon={STAGE_ICONS[11]} label="Stage 6 · SD Refunds" value={kpis.byStage?.[11] ?? '—'} loading={loading} tint="info"
          footnote="Christopher"
          active={stageFilter === 11} onClick={() => toggleFilter(11)}
        />
        {/* Stage 6A (HOD) / 6B (Accounts) / 6C (CEO) — explicit request
            2026-10-05, reworked 2026-10-07 to insert Accounts and make CEO
            conditional on the SD Amount to be Refunded (see
            refunds.service.js's _isCeoRequired). Filters this dashboard's own
            table by cross-referencing container number against the refunds
            sheet (see the `filtered` useMemo above), same as every other KPI
            card here. Each card only renders for a caller who can act on
            that stage, same gate SdRefundApprovalTab itself falls back to a
            "no permission" message for — hiding the card entirely here is
            nicer than a dead-end click. */}
        {canAct('refundsApprovalHod') && (
          <StatCard size="sm"
            icon="clock" label="Stage 6A · HOD Approval" value={hodPendingCount} loading={loading} tint="approval"
            footnote="Pushpalata"
            active={stageFilter === 'hod'} onClick={() => toggleFilter('hod')}
          />
        )}
        {canAct('refundsApprovalAccounts') && (
          <StatCard size="sm"
            icon="clock" label="Stage 6B · Accounts Approval" value={accountsPendingCount} loading={loading} tint="approval"
            footnote="Shivani"
            active={stageFilter === 'accounts'} onClick={() => toggleFilter('accounts')}
          />
        )}
        {canAct('refundsApprovalCeo') && (
          <StatCard size="sm"
            icon="clock" label="Stage 6C · CEO Approval" value={ceoPendingCount} loading={loading} tint="approval"
            footnote="Akash Sir"
            active={stageFilter === 'ceo'} onClick={() => toggleFilter('ceo')}
          />
        )}
        {/* Explicit request 2026-09-29: replaces "Completed this month" —
            Stage 6 (FMS Closed, internal 8) was the one active stage with no
            card of its own on this dashboard at all; same pattern as every
            other Stage N card above (STAGE_ICONS[8]/byStage[8] already
            existed and were computed, just never rendered here). No footnote
            (unlike every other Stage N card): its `owner` (stages.js) was
            renamed 'Sales' -> 'FMS Closed' the same day, which would just
            repeat this card's own label.
            RELABELED 2026-10-01 "Stage 6" -> "Stage 7": SD Refunds (internal
            11, card just above) is now the display Stage 6.
            RELABELED AGAIN 2026-10-03 "FMS Closed" -> "Payment Status". */}
        <StatCard size="sm"
          icon={STAGE_ICONS[8]} label="Stage 7 · Payment Status" value={kpis.byStage?.[8] ?? '—'} loading={loading} tint="info"
          footnote="FMS Done"
          active={stageFilter === 8} onClick={() => toggleFilter(8)}
        />
      </div>

      <Card
        title="Active off-lease pipeline"
        actions={
          <>
            <div className={styles.viewRow}>
              {VIEWS.map((v) => (
                <button
                  key={v.key}
                  type="button"
                  className={`${styles.viewTab} ${view === v.key ? styles.viewTabActive : ''}`}
                  onClick={() => setView(v.key)}
                >
                  {v.label}
                </button>
              ))}
            </div>
            <Button variant="secondary" size="sm" onClick={reload}>Refresh</Button>
          </>
        }
      >
        <div className={styles.toolbar}>
          {/* Month grouped with Search in their own row so they always sit
              side by side — explicit request 2026-09-23: the toolbar's own
              space-between wrap previously let Month isolate onto its own
              line above Search instead of sitting next to it. */}
          <div className={styles.searchRow}>
            <FilterBar
              filters={[{
                key: 'month',
                label: 'Month',
                value: monthFilter,
                onChange: setMonthFilter,
                options: monthOptions
              }, {
                key: 'salePerson',
                label: 'Sale Person',
                value: salePersonFilter,
                onChange: setSalePersonFilter,
                options: salePersonOptions
              }]}
            />
            <SearchBar variant="large" value={search} onChange={setSearch} placeholder="Search container, client, lease, location…" />
          </div>
          {/* An active filter has to be visible and removable here — otherwise
              a shrunken list looks like missing data. */}
          {(stageFilter != null || groupFilter != null) && (
            <button type="button" className={styles.filterChip} onClick={() => { setStageFilter(null); setGroupFilter(null); }} title="Clear filter">
              <span className={styles.filterKicker}>Filtered by</span>
              <span className={styles.filterName}>{filterLabel}</span>
              <span className={styles.filterX} aria-hidden="true">×</span>
              <span className={styles.srOnly}>Clear filter</span>
            </button>
          )}
          <span className={styles.count}>{filtered.length} record{filtered.length === 1 ? '' : 's'}</span>
        </div>

        {/* Bulk SD Refund selection bar — shown above EITHER view, explicit
            follow-up 2026-11-10 ("stage 6 mai jaise hi rk do click kiya na
            tho upar ek SD Refunds ka from dedo"): the checkbox lives beside
            each record (View 1's own Container column, View 2's own new
            column) and this bar is the one shared trigger for filling the
            form against everything currently checked, in whichever view the
            user happens to be looking at. */}
        {!loading && !error && showSelectCol && selectedEntries.length > 0 && (
          <div className={styles.bulkBar}>
            <span><span className={styles.bulkBarCount}>{selectedEntries.length}</span> selected</span>
            {stageFilter === FINAL_BILLING_STAGE_KEY ? (
              <Button size="sm" variant="primary" onClick={() => setBulkStage5Open(true)}>Fill Stage 5 Form for all</Button>
            ) : (
              <Button size="sm" variant="primary" onClick={() => setBulkRefundOpen(true)}>Fill one SD Refund form for all</Button>
            )}
            <Button size="sm" variant="secondary" onClick={() => setSelectedKeys(new Set())}>Clear selection</Button>
          </div>
        )}

        {view === 'book' && (
          <OrderBookView
            highlight={debouncedSearch}
            items={filtered}
            loading={loading}
            error={error}
            onRetry={reload}
            onOpenTab={onOpenTab}
            refundRows={refundRows}
            tatRecords={tatRecords}
            /* Refetches the dashboard after a stage form saves, so the
               chip that just went from current to done -- and the next one
               that becomes current -- update without a manual Refresh. */
            onStageSaved={reload}
            searching={!!search}
            /* No reload — the remark cell keeps itself up to date locally.
               Refetching all 35 records to reflect one comment is what made
               Save and Delete sit spinning. */
            onOpenRecord={openRecord}
            showSelectCol={showSelectCol}
            selectedKeys={selectedKeys}
            onToggleSelected={toggleRowSelected}
          />
        )}

        {view === 'table' && loading && <SkeletonTable columns={8} rows={8} />}
        {view === 'table' && !loading && error && <ErrorState message={error} onRetry={reload} />}
        {view === 'table' && !loading && !error && filtered.length === 0 && (
          <EmptyState message="No active off-lease containers" hint={search ? 'Try a different search' : undefined} />
        )}

        {view === 'table' && !loading && !error && filtered.length > 0 && (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              {/* table-layout: fixed needs explicit widths to actually fit
                  8 columns in one view without horizontal scroll (the ask
                  this whole pass is for) — percentages of the table's own
                  width, not literal px, same proportional approach
                  LeaseExpiryPage.jsx's own colWidths already uses. */}
              <colgroup>
                {showSelectCol && <col style={{ width: '28px' }} />}
                <col style={{ width: '7%' }} />
                <col style={{ width: '11%' }} />
                <col style={{ width: '15%' }} />
                <col style={{ width: '16%' }} />
                <col style={{ width: '11%' }} />
                <col style={{ width: '22%' }} />
                <col style={{ width: '9%' }} />
                <col style={{ width: '9%' }} />
              </colgroup>
              <thead>
                <tr>
                  {showSelectCol && <th className={styles.selectCol} />}
                  <th>Lease ID</th>
                  <th>Container</th>
                  <th>Client</th>
                  <th>Status</th>
                  <th>Delay</th>
                  <th>Main hold-up</th>
                  <th>With</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {/* Container alone is not unique — one container can be
                    off-leased under two leases (TRIU6681671), which React
                    reported as a duplicate key and could collapse into one
                    row. The lease is what distinguishes the records. */}
                {filtered.map((it, i) => {
                  const { refundEntry, tatRecord } = fmsMatch.get(it) || {};
                  const rowKey = `${it.leaseId || i}-${it.container}`;
                  const selectKey = `${it.leaseId || ''}-${it.container}`;
                  /* Explicit request 2026-11-18 (reference order-tracker
                     table — Status pill, Days-late, Main hold-up, With
                     columns): status/currentTat are the exact same
                     computations View 1's own cards already make per row
                     (OrderBookView.jsx), reused here rather than
                     reimplemented, so the two views can never disagree about
                     what's going on with a given record. */
                  const status = statusOf(it, refundEntry);
                  const currentTat = currentTatStage(tatRecord, status.tatKey);
                  const owner = status.tab ? (OWNER_BY_TAB[status.tab] || '—') : '—';
                  return (
                  /* Row itself opens the full record page (same destination
                     View 1's cards already use, openRecord) — explicit
                     request 2026-11-05 ("click the row then open view 2"),
                     scoped to View 2 only. The Open/Approve button keeps its
                     own job (jump straight to that stage's tab) — its click
                     stops propagation so it doesn't also fire the row's
                     navigate-to-record-page. Same for the selection checkbox,
                     explicit request 2026-11-10 (bulk SD Refund form). */
                  <tr key={rowKey} className={styles.clickableRow} onClick={() => openRecord(it, 'phases')}>
                    {showSelectCol && (
                      <td className={styles.selectCol} onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selectedKeys.has(selectKey)}
                          onChange={() => toggleRowSelected(selectKey)}
                          aria-label={`Select ${it.container} for bulk SD Refund`}
                        />
                      </td>
                    )}
                    <td className={styles.leaseId}><Highlight text={it.leaseId || '—'} query={debouncedSearch} /></td>
                    <td className={styles.container}><Highlight text={it.container} query={debouncedSearch} /></td>
                    <td><Highlight text={it.clientName || '—'} query={debouncedSearch} /></td>
                    <td><span className={`${styles.statusPill} ${styles[status.tone]}`}>{status.label}</span></td>
                    <td className={currentTat?.status === 'Delayed' ? styles.delayLate : styles.delayOk}>
                      {currentTat?.delayLabel || '—'}
                    </td>
                    <td className={styles.holdUp} title={holdUpFor(it, status)}>{holdUpFor(it, status)}</td>
                    <td>{owner}</td>
                    <td className={styles.actionCell}>
                      {it.stageClass === 'approval' ? (
                        <Button size="sm" variant="primary" onClick={(e) => { e.stopPropagation(); onOpenTab?.('approval'); }}>Approve</Button>
                      ) : it.stageClass === 'done' ? (
                        <span className={styles.doneTag}>Released</span>
                      ) : it.stageClass === 'rejected' ? (
                        <span className={styles.rejectedTag}>Rejected</span>
                      ) : (
                        <Button size="sm" variant="secondary" onClick={(e) => { e.stopPropagation(); onOpenTab?.(`stage${it.currentStageNum}`); }}>Open</Button>
                      )}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {bulkRefundOpen && selectedEntries.length > 0 && (
        <BulkRefundModal
          entries={selectedEntries}
          onClose={() => setBulkRefundOpen(false)}
          onSubmitted={() => { setSelectedKeys(new Set()); setBulkRefundOpen(false); reload(); }}
        />
      )}

      <BulkStage5Modal
        open={bulkStage5Open && selectedEntries.length > 0}
        items={selectedEntries.map((en) => ({ containerNo: en.container, rowNum: en.rowNum }))}
        submitting={bulkStage5Busy}
        error={bulkStage5Error}
        onClose={() => { setBulkStage5Open(false); setBulkStage5Error(''); }}
        onSubmit={handleBulkStage5Submit}
      />

    </>
  );
}

/* MiniPipeline (the plain dot-tracker this View 2 table used to show here)
   was replaced 2026-11-05 ("this table replace same this table show for
   view 2") by ChipStrip (OrderBookView.jsx) — the real 1/1A/2/.../6A/6B/6C/7
   chips View 1's own cards show, which the dot tracker had no way to
   represent (it never showed the SD Refund sub-stages at all). Removed
   rather than left as dead code once nothing called it any more. */
