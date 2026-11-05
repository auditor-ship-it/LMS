import { useMemo, useState } from 'react';
import { ErrorState, EmptyState, Icon, Button, RichTextEditor } from '../../components/ui/index.js';
import { SkeletonCards } from '../../components/ui/Skeleton.jsx';
import { apiErrorMessage } from '../../shared/auth/index.js';
import { postRemark, editRemark, removeRemark, fetchRemarkThread } from '../../services/offLease.service.js';
import { STAGES, isReadOnlyStage } from '../../constants/stages.js';
import { usePermission } from '../../hooks/usePermission.js';
import { Highlight } from './Highlight.jsx';
import { StageDetailModal } from '../stages/StageDetailModal.jsx';
import { formatActionTimestamp } from '../../utils/formatDateTime.js';
import styles from './OrderBookView.module.css';

/**
 * Off-Lease dashboard, order-book layout — one row per off-lease record with
 * the whole pipeline collapsed into a strip of numbered chips, so where every
 * container has got to is readable down a single column without opening
 * anything.
 *
 * Same data as the table view (GET /offlease/dashboard); this is a second
 * presentation of it, not a second source. It reads and never writes — the
 * status pill links through to the tab that actually owns the action.
 */

/** The chips, left to right: Stage 1, Stage 1A (the approval gate), then the
 *  rest of the workflow (Transportation, Gate In, Inspection, Final Billing,
 *  KAM) straight off STAGES, in WORKFLOW order. 1A is drawn from a hand-built
 *  object rather than STAGES because it isn't a stage of its own — the
 *  decision gate between Stage 1 and Stage 2. ("LR & Return Transportation",
 *  internal 10, was a real stage 2026-09-18 to 2026-09-22, also needing no
 *  hand-built chip — removed from the workflow again, so STAGES no longer
 *  includes it.)
 *
 *  Each chip opens that stage's own tab (onOpenTab) when clicked, same as
 *  the status pill beside them -- a completed or future chip is just as
 *  clickable as the current one, so any stage's record is one click away
 *  regardless of where the container actually is right now. */
/* Internal stage number (STAGES' own `.number`, from constants/stages.js) ->
   offLeaseTatTracking.service.js's own TAT stage key — same mapping
   offlease.controller.js's getContainerDetail uses (internalToTatKey) to
   attach tatV2 to the Container History table. '1A'/'6A'/'6B'/'6C' have no
   internal stage number of their own (approval gates, not pipeline stages),
   matched by their literal key instead — see tatSuffix below. */
const TAT_KEY_BY_INTERNAL = { 1: '1', 6: '2', 7: '3', 3: '4', 5: '5', 11: '6', 8: '7' };

/** " · Entered 20-Jul-2026 06:11 PM · 9d 4h Early" — appended to a chip's
 *  hover title, explicit request 2026-11-04 ("now this is stage show stage
 *  wise entry stage and show dely only"): just the two fields asked for,
 *  not the full Planned/Actual breakdown the dedicated TAT Tracking page
 *  and Container History table already show. '' when this stage hasn't
 *  been entered yet (tatCell is null for a still-Pending stage) or no TAT
 *  record matched this record at all (tatRecord undefined). */
function tatSuffix(tatRecord, tatKey) {
  const t = tatRecord?.stages?.find((s) => s.key === tatKey);
  if (!t?.entryAt) return '';
  const entry = formatActionTimestamp(t.entryAt);
  return t.delayLabel ? ` · Entered ${entry} · ${t.delayLabel}` : ` · Entered ${entry}`;
}

/** This record's TAT data for whatever stage statusOf's own `tatKey` says is
 *  current — see statusOf's doc comment for why this trusts that single
 *  source instead of independently re-deriving "current" from the TAT
 *  data's own entry/actual pattern (which can disagree when a stage's TAT
 *  sourcing — e.g. Stage 2's FMS match — never resolved even though the
 *  real pipeline moved past it). */
function currentTatStage(tatRecord, tatKey) {
  if (!tatKey) return null;
  return tatRecord?.stages?.find((s) => s.key === tatKey) || null;
}

export function buildChips(item, refundEntry, tatRecord) {
  const [first, ...rest] = STAGES;
  const approval = String(item.approvalStatus || '').trim().toLowerCase();
  const stageOf = (n) => item.stages?.find((s) => s.stage === n);

  const chip = (stage) => {
    const s = stageOf(stage.number);
    return {
      key: `s${stage.number}`,
      label: String(stage.display),
      title: `Stage ${stage.display} · ${stage.label}${s?.done ? ` — completed ${formatActionTimestamp(s.timestamp)}`.trimEnd() : ' — pending'}${tatSuffix(tatRecord, TAT_KEY_BY_INTERNAL[stage.number])}`,
      tab: `stage${stage.number}`,
      stageNumber: stage.number,
      tone: s?.done ? 'done' : item.currentStageNum === stage.number ? 'current' : 'future'
    };
  };

  const gate = {
    key: 'gate',
    label: '1A',
    title: `Stage 1A · Intimation Approval — ${approval || 'pending'}${tatSuffix(tatRecord, '1A')}`,
    tab: 'approval',
    tone: approval === 'approved' ? 'done'
      : approval === 'rejected' ? 'rejected'
        : item.stageClass === 'approval' ? 'current' : 'future'
  };

  /* 6A/6B/6C -- the HOD/Accounts/CEO SD Refund approval gates, same shape as
     1A above. refundEntry comes from the separate Refunds sheet (see
     refunds.service.js), matched to this record by container number -- it's
     absent entirely until the SD Refund is actually filed, in which case all
     three chips just show future.
     REWORKED 2026-10-07: HOD -> Accounts -> CEO, CEO conditional on the
     bill's Amount to Pay. The 6C chip always stays -- explicit request
     ("stage remove mat karo, status skipped hoga"): once a refund entry
     exists and its ceoRequired flag is explicitly false, the chip shows
     'done' tone with a Skipped title instead of disappearing. Still shown as
     'future' when no refund has been filed yet at all (ceoRequired unknown). */
  const hodStatus = String(refundEntry?.hodStatus || '').trim().toLowerCase();
  const accountsStatus = String(refundEntry?.accountsStatus || '').trim().toLowerCase();
  const ceoStatus = String(refundEntry?.ceoStatus || '').trim().toLowerCase();
  const sdHod = {
    key: 'sdHod',
    label: '6A',
    title: `Stage 6A · HOD Approval — ${hodStatus || 'pending'}${tatSuffix(tatRecord, '6A')}`,
    tab: 'sdRefundsHod',
    tone: hodStatus === 'approved' ? 'done'
      : hodStatus === 'rejected' ? 'rejected'
        : refundEntry?.currentStage === 'hod' ? 'current' : 'future'
  };
  const sdAccounts = {
    key: 'sdAccounts',
    label: '6B',
    title: `Stage 6B · Accounts Approval — ${accountsStatus || 'pending'}${tatSuffix(tatRecord, '6B')}`,
    tab: 'sdRefundsAccounts',
    tone: accountsStatus === 'approved' ? 'done'
      : accountsStatus === 'rejected' ? 'rejected'
        : refundEntry?.currentStage === 'accounts' ? 'current' : 'future'
  };
  /* BUG FOUND AND FIXED 2026-11-04 (explicit spec: "Never skip CEO approval
     before Accounts approval is completed") — ceoRequired is known from the
     refund's Amount to Pay alone, available the moment it's submitted, so
     this chip used to show 'done'/Skipped before Accounts (or even HOD) had
     acted at all — live-confirmed on TRIU6617353. ceoResolved additionally
     requires accountsStatus === 'approved'; until then this chip falls
     through to its normal current/future tone, same as 6A/6B above. */
  const ceoResolved = refundEntry && refundEntry.ceoRequired === false && accountsStatus === 'approved';
  const sdCeo = {
    key: 'sdCeo',
    label: '6C',
    title: `Stage 6C · CEO Approval — ${ceoResolved ? 'skipped' : (ceoStatus || 'pending')}${tatSuffix(tatRecord, '6C')}`,
    tab: 'sdRefundsCeo',
    tone: ceoResolved ? 'done'
      : ceoStatus === 'approved' ? 'done'
        : ceoStatus === 'rejected' ? 'rejected'
          : refundEntry?.currentStage === 'ceo' ? 'current' : 'future'
  };

  const chips = [chip(first), gate];
  for (const stage of rest) {
    chips.push(chip(stage));
    if (stage.number === 11) chips.push(sdHod, sdAccounts, sdCeo);
  }
  return chips;
}

/** Same composite container+Lease-ID matching this component's own
 *  refundByContainer/tatByContainer useMemos use internally (see those for
 *  the full cross-lease-contamination reasoning) — exported standalone so a
 *  DIFFERENT presentation of the same items (PipelineDashboard.jsx's and
 *  SalePersonTab.jsx's own View 2 tables) can resolve the same
 *  refundEntry/tatRecord per item without duplicating that matching logic a
 *  third time. Returns a Map keyed by item (object identity, not container —
 *  container alone is not unique). */
export function matchRefundAndTat(items, refundRows, tatRecords) {
  const refundByComposite = new Map();
  const refundByContainerSingle = new Map();
  const isBetterRefund = (existing) => !existing || existing.currentStage === 'done' || existing.currentStage === 'rejected';
  for (const r of refundRows || []) {
    const container = String(r.containerNo || '').trim().toUpperCase();
    if (!container) continue;
    const leaseId = String(r.offLeaseId || '').trim().toUpperCase();
    if (leaseId) {
      const key = `${container}|${leaseId}`;
      if (isBetterRefund(refundByComposite.get(key))) refundByComposite.set(key, r);
    }
    if (isBetterRefund(refundByContainerSingle.get(container))) refundByContainerSingle.set(container, r);
  }
  const tatByComposite = new Map();
  const tatByContainerSingle = new Map();
  for (const r of tatRecords || []) {
    const container = String(r.containerNo || '').trim().toUpperCase();
    if (!container) continue;
    const leaseId = String(r.leaseId || '').trim().toUpperCase();
    if (leaseId) tatByComposite.set(`${container}|${leaseId}`, r);
    if (!tatByContainerSingle.has(container)) tatByContainerSingle.set(container, r);
  }
  const itemsByContainerCount = new Map();
  for (const it of items) {
    const c = String(it.container || '').trim().toUpperCase();
    if (c) itemsByContainerCount.set(c, (itemsByContainerCount.get(c) || 0) + 1);
  }
  const result = new Map();
  for (const it of items) {
    const container = String(it.container || '').trim().toUpperCase();
    const leaseId = String(it.leaseId || '').trim().toUpperCase();
    let refundEntry = leaseId ? refundByComposite.get(`${container}|${leaseId}`) : undefined;
    if (!refundEntry && itemsByContainerCount.get(container) === 1) refundEntry = refundByContainerSingle.get(container);
    let tatRecord = leaseId ? tatByComposite.get(`${container}|${leaseId}`) : undefined;
    if (!tatRecord && itemsByContainerCount.get(container) === 1) tatRecord = tatByContainerSingle.get(container);
    result.set(it, { refundEntry, tatRecord });
  }
  return result;
}

/** buildChips' own keys, split into the SAME 3 phases PipelineDashboard.jsx's
 *  scorecards use (STAGE_GROUPS there) — explicit request 2026-11-05
 *  ("change only view 2", "group the stage chips into 3 phases"): View 2's
 *  own Stage column groups its chips to match, View 1 untouched (it builds
 *  its chips straight from buildChips, never through ChipStrip). Any chip
 *  key not listed here (currently just Payment Status' own 's8') falls
 *  through ungrouped, after the three phase pills. */
const CHIP_PHASES = [
  ['s1', 'gate', 's6'],
  ['s7', 's3', 's5'],
  ['s11', 'sdHod', 'sdAccounts', 'sdCeo']
];

/** Non-interactive version of the SAME chip strip every order-book card
 *  shows (buildChips) — explicit request 2026-11-05 ("this table replace
 *  same this table show for view 2"): the compact View 2 table wants the
 *  real 1/1A/2/.../6A/6B/6C/7 chips, not MiniPipeline's plain dot tracker,
 *  which had no way to show the SD Refund sub-stages at all. No click
 *  handlers — View 2 already has its own Open/Approve button per row for
 *  the actual action, same reasoning the status pill elsewhere in this app
 *  only links out when it's genuinely the current actionable thing. */
export function ChipStrip({ item, refundEntry, tatRecord }) {
  const chips = buildChips(item, refundEntry, tatRecord);
  const byKey = new Map(chips.map((c) => [c.key, c]));
  const grouped = CHIP_PHASES.map((keys) => keys.map((k) => byKey.get(k)).filter(Boolean));
  const groupedKeys = new Set(CHIP_PHASES.flat());
  const leftover = chips.filter((c) => !groupedKeys.has(c.key));
  // Explicit follow-up 2026-11-05 ("this is not same view 1 jaisa chhaiye
  // hai"): View 1's own row ends with a readable status pill ("Stage 2 ·
  // Transportation") after the chips, not just the chips alone — statusOf is
  // the SAME single source of truth the chips themselves already trust (see
  // its own doc comment), so this can never disagree with what the chips show.
  const status = statusOf(item, refundEntry);
  const renderChip = (c) => (
    <span key={c.key} className={`${styles.chip} ${styles[c.tone]}`} title={c.title}>
      {c.label}
    </span>
  );
  return (
    <span className={styles.strip}>
      {grouped.map((group, i) => group.length > 0 && (
        <span key={i} className={styles.chipGroup}>{group.map(renderChip)}</span>
      ))}
      {leftover.map(renderChip)}
      <span className={`${styles.status} ${styles[status.tone]}`}>{status.label}</span>
    </span>
  );
}

/** Status pill wording and tone, and which tab owns acting on it. Also
 *  returns `tatKey` — the SAME stage this label is reporting on, expressed
 *  as offLeaseTatTracking.service.js's own key, so currentTatStage (below)
 *  can show that exact stage's Entry/TAT/Delay instead of independently
 *  re-deriving "which stage is current" from the TAT data's own entry/
 *  actual pattern — BUG FOUND AND FIXED 2026-11-04 (live on GSOU6384240/
 *  OF0004): that independent approach picked Stage 2/Transportation (its
 *  own FMS match never fully resolved, so TAT still read it as "open") even
 *  though the record had genuinely moved on to Stage 6 already — the chip
 *  row and this status pill already agree on "where it actually is" via
 *  item.currentStageNum/refundEntry; trust that single source instead of a
 *  second, divergent one. */
export function statusOf(item, refundEntry) {
  /* The off-lease row alone cannot say whether the SD Refund has been signed
     off — that lives in the refunds sheet. So a record the pipeline calls done
     (or has moved on to Payment Status) while its refund still waits on HOD or
     CEO is NOT released: say what it is actually waiting for. */
  if (refundEntry && (item.stageClass === 'done' || item.currentStageNum === 8)) {
    const hod = String(refundEntry.hodStatus || '').trim().toLowerCase();
    const accounts = String(refundEntry.accountsStatus || '').trim().toLowerCase();
    const ceo = String(refundEntry.ceoStatus || '').trim().toLowerCase();
    if (hod === 'rejected' || accounts === 'rejected' || (refundEntry.ceoRequired && ceo === 'rejected')) {
      const which = hod === 'rejected' ? 'HOD' : accounts === 'rejected' ? 'Accounts' : 'CEO';
      return { label: `SD refund rejected (${which})`, tone: 'danger', tab: null, tatKey: null };
    }
    if (hod !== 'approved') return { label: 'Stage 6A · HOD approval pending', tone: 'warn', tab: 'sdRefundsHod', tatKey: '6A' };
    if (accounts !== 'approved') return { label: 'Stage 6B · Accounts approval pending', tone: 'warn', tab: 'sdRefundsAccounts', tatKey: '6B' };
    if (refundEntry.ceoRequired && ceo !== 'approved') return { label: 'Stage 6C · CEO approval pending', tone: 'warn', tab: 'sdRefundsCeo', tatKey: '6C' };
  }
  switch (item.stageClass) {
    case 'approval': return { label: 'Pending approval', tone: 'warn', tab: 'approval', tatKey: '1A' };
    case 'rejected': return { label: 'Rejected', tone: 'danger', tab: null, tatKey: null };
    case 'done': return { label: 'Released', tone: 'success', tab: null, tatKey: null };
    default: return {
      label: item.currentStage || 'In progress',
      tone: 'info',
      tab: item.currentStageNum ? `stage${item.currentStageNum}` : null,
      tatKey: item.currentStageNum ? TAT_KEY_BY_INTERNAL[item.currentStageNum] : null
    };
  }
}

/**
 * The live remark for one record — the latest comment, plus an inline rich-text
 * composer to add another. Remarks are written here, not read out of the stage
 * columns: a stage remark belongs to its stage and freezes when that stage
 * completes, whereas this is the running commentary on the record.
 */
function RemarkCell({ item, onSaved }) {
  const [open, setOpen] = useState(false);
  const [html, setHtml] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  /* What this cell currently shows. Seeded from the dashboard row, then
     maintained locally after a write: reloading the whole dashboard to reflect
     one remark meant refetching all 35 records (seconds, and a Sheets read) on
     every save and delete, which is what made the button sit spinning. */
  const [local, setLocal] = useState(null);
  const view = local || {
    html: item.remarkHtml, on: item.remarkOn, by: item.remarkBy, count: item.remarkCount
  };

  /* The full thread, fetched only when the rail is first opened. Loading it
     with the dashboard would mean one request per record for history most
     rows never get looked at. */
  const [thread, setThread] = useState(null);
  const [threadBusy, setThreadBusy] = useState(false);
  const [threadError, setThreadError] = useState('');
  /* Explicit request 2026-11-05 ("5 baar remkas date timestamp and emails
     sab dikhe" — every remark's date/timestamp/email should show, not just
     the latest): the thread used to reveal only on HOVER
     (:hover/:focus-within), which a non-technical/touch user has no reason
     to ever discover — it looked like only the newest remark was kept. Now
     an explicit click toggles it open and it stays open (not hover-gated),
     same click-to-reveal pattern as everything else in this app. The thread
     was never stage-scoped to begin with (it's keyed on container+lease, not
     on the row's current stage), so a remark written back at Stage 1 was
     already included once Stage 4 opened this same rail — that part needed
     no backend change, only this cell being visible enough to actually show
     it. */
  const [expanded, setExpanded] = useState(false);
  /* Which existing remark is being edited — null means the composer is
     writing a NEW one. Edit and add share the same editor. */
  const [editingId, setEditingId] = useState(null);

  const loadThread = async () => {
    if (thread || threadBusy) return;
    setThreadBusy(true);
    setThreadError('');
    try {
      setThread(await fetchRemarkThread(item.container, item.leaseId));
    } catch (e) {
      /* Surfaced, not swallowed: showing "No history" for a failed read would
         claim the remarks are gone, and the Delete button would vanish with
         them. Left unset so the next retry can succeed. */
      setThreadError(apiErrorMessage(e));
    } finally {
      setThreadBusy(false);
    }
  };

  const toggleExpanded = () => {
    setExpanded((v) => !v);
    loadThread();
  };

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
      /* Explicit request 2026-11-05 ("stage difind which stage" — show which
         stage each remark belongs to): a NEW remark posted from this
         dashboard cell is tagged with the container's CURRENT stage at the
         moment it's written — same `stage` column StageDetailModal's own
         StageRemarks already tags its entries with (offleaseRemarks.service
         .js's getRemarkThread returns every remark for the record either
         way, this was already reaching the thread below, just never shown).
         An edit never changes the original stage tag — only the body/edited
         stamp are rewritten server-side. */
      const saved = editingId
        ? await editRemark(item.container, editingId, html)
        : await postRemark(item.container, item.leaseId, html, item.currentStageNum);
      setOpen(false);
      setEditingId(null);
      setHtml('');
      setThread(null); // stale now — refetched on the next open
      /* An edit replaces the newest entry only if that IS the newest; a new
         remark always becomes it and adds to the count. */
      setLocal({
        html: saved?.html ?? view.html,
        on: saved?.timestamp ?? view.on,
        by: saved?.enteredBy ?? view.by,
        count: editingId ? view.count : (view.count || 0) + 1
      });
      onSaved?.(item, saved);
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
      await removeRemark(item.container, r.id);
      /* Drop it from the thread in place rather than refetching: the delete
         already told us it succeeded, and the surviving entries are unchanged. */
      const left = (thread || []).filter((x) => x.id !== r.id);
      setThread(left);
      const newest = left[0];
      setLocal({
        html: newest?.html || '',
        on: newest?.timestamp || '',
        by: newest?.enteredBy || '',
        count: left.length
      });
    } catch (e) {
      setThreadError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    /* The whole cell is interactive — writing, editing and browsing history
       all happen in place, so no click here should also open the record. */
    <div
      className={styles.remarkCol}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className={styles.remarkHead}>
        <span className={styles.sideLabel}>Remark</span>

        {/* The rail: one tick per stored remark, so the depth of the thread is
            visible without opening anything. A click toggles the full list
            open — not hover-only any more (see `expanded`'s own doc comment
            above). Nothing is ever replaced — every remark is kept, and this
            is how the older ones are reached, regardless of which stage the
            record is at now. */}
        {view.count > 0 && (
          <span
            className={styles.rail}
            onClick={toggleExpanded}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExpanded(); } }}
            tabIndex={0}
            role="button"
            aria-expanded={expanded}
            aria-label={`${view.count} remark${view.count === 1 ? '' : 's'} — ${expanded ? 'hide' : 'show'} history`}
          >
            {/* Capped so a long thread cannot stretch the row; the count next
                to it stays exact. */}
            {Array.from({ length: Math.min(view.count, 6) }, (_, i) => (
              <i key={i} className={styles.railTick} />
            ))}
            <span className={styles.railCount}>{view.count}</span>

            {expanded && (
            <span className={`${styles.railPop} ${styles.railPopOpen}`} role="dialog" onClick={(e) => e.stopPropagation()}>
              <span className={styles.railPopHeadRow}>
                <span className={styles.railPopHead}>
                  {view.count} remark{view.count === 1 ? '' : 's'}
                </span>
                {/* Explicit request 2026-11-05 ("one more option this tab is
                    close"): an explicit close button — clicking the tick
                    rail again already toggles it shut, but that's not
                    obvious once the popup itself has your attention. */}
                <button type="button" className={styles.railClose} onClick={() => setExpanded(false)} aria-label="Close">×</button>
              </span>
              {threadBusy && <span className={styles.railPopMeta}>Loading…</span>}
              {thread?.map((r) => {
                /* Explicit request 2026-11-05 ("stage difind which stage"):
                   which stage the container was at when this remark was
                   written — blank for an older remark saved before the
                   Stage column existed, or one added from this same
                   record-wide cell before this change. */
                const stageLabel = r.stage && STAGES.find((s) => s.number === Number(r.stage))?.label;
                return (
                <span className={styles.railItem} key={r.id}>
                  <span className={styles.railItemBody} dangerouslySetInnerHTML={{ __html: r.html }} />
                  <span className={styles.railItemFoot}>
                    <span className={styles.railPopMeta}>
                      {[
                        stageLabel ? `Stage ${r.stage} · ${stageLabel}` : null,
                        formatActionTimestamp(r.timestamp),
                        r.enteredBy
                      ].filter(Boolean).join(' · ')}
                      {r.editedOn && ' · edited'}
                    </span>
                    {/* Always offered; the server rejects anyone who is not the
                        author (or a roles admin), so the UI does not have to
                        know who may act — and cannot get it wrong. */}
                    <button type="button" className={styles.railAction} onClick={() => beginEdit(r)}>Edit</button>
                    <button
                      type="button"
                      className={`${styles.railAction} ${styles.railDanger}`}
                      onClick={() => remove(r)}
                      disabled={busy}
                    >
                      Delete
                    </button>
                  </span>
                </span>
                );
              })}
              {threadError && <span className={styles.remarkError}>{threadError}</span>}
              {thread && !thread.length && !threadBusy && <span className={styles.railPopMeta}>No history</span>}
            </span>
            )}
          </span>
        )}

        {/* Explicit request 2026-11-05 ("ek aur remaks add kar na hai tho
            kaise karu" — "I need to add ANOTHER remark, how do I do it"):
            this button always opens a BLANK composer and posts a NEW thread
            entry — editingId is never set here, only beginEdit(r) (the
            per-item Edit button inside the now-always-reachable thread list
            above) sets it. Labeling it "Edit" once a remark existed was
            misleading — it looked like it would change the shown remark in
            place, when it actually adds another one alongside it. Always
            "Add a remark" now, matching StageDetailModal.jsx's own
            StageRemarks button wording for the same action. */}
        {!open && (
          <button type="button" className={styles.remarkAdd} onClick={() => setOpen(true)}>
            <Icon name="edit" className={styles.remarkAddIcon} />
            Add a remark
          </button>
        )}
      </div>

      {!open && (view.html
        ? (
          <>
            {/* Server-sanitised on the way in — the sheet only ever holds the
                allow-listed subset, never script/style/attributes. */}
            <div className={styles.remarkText} dangerouslySetInnerHTML={{ __html: view.html }} />
            {(view.on || view.by) && (
              <div className={styles.remarkOn}>{[formatActionTimestamp(view.on), view.by].filter(Boolean).join(' · ')}</div>
            )}
          </>
        )
        : <p className={styles.remarkEmpty}>—</p>)}

      {open && (
        <div className={styles.remarkEditor}>
          <RichTextEditor
            value={html}
            onChange={setHtml}
            placeholder={editingId ? 'Edit this remark…' : 'Add a remark…'}
            disabled={busy}
            autoFocus
          />
          {error && <p className={styles.remarkError}>{error}</p>}
          <div className={styles.remarkActions}>
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

export function OrderBookView({ highlight, items, loading, error, onRetry, onOpenTab, searching, onRemarkSaved, onOpenRecord, onStageSaved, refundRows, tatRecords }) {
  const { canAct } = usePermission();
  /* Which record+stage's own form is open, or null. Distinct from
     onOpenRecord (the read-only all-stage history modal) -- this is the
     single stage's EDITABLE (or, for an already-completed stage, view-only)
     form, the same StageDetailModal the Stage N tab's own pending list
     opens, just reached directly from this record's chip instead. */
  const [stageForm, setStageForm] = useState(null); // { container, stageNumber, readOnly, identityOnly } | null

  /* A stage TYPE can be read-only altogether (e.g. Transportation -- a
     master list with no form at all), same rule StagePageBase applies.
     Layered under that: THIS record's chip tone decides whether ITS row is
     editable right now -- 'current' is the one stage actually open for
     action; 'done' may be reviewed but not overwritten; 'future' cannot be
     opened at all until the workflow reaches it. */
  const openStageChip = (containerNo, chip, rowNum) => {
    if (chip.tone === 'future') return; // locked -- not clickable
    const readOnlyType = isReadOnlyStage(chip.stageNumber);
    const canEditNow = !readOnlyType && chip.tone === 'current' && canAct(`offlease${chip.stageNumber}`);
    setStageForm({ container: containerNo, rowNum, stageNumber: chip.stageNumber, readOnly: !canEditNow, identityOnly: readOnlyType });
  };
  /* Keyed by container number + Lease ID (offLeaseId) composite — NOT
     container alone. BUG FOUND AND FIXED 2026-11-04 (explicit report, live
     on TRIU6617353): this container has two genuinely separate Off-Lease
     Tracking rows (a re-lease to a different client after the first lease
     ended — OF0048/Kirloskar, long finished, now sitting at Stage 5; and
     OF0090/Zenfold, the current one, genuinely at Stage 6A). Matching by
     container alone made OF0090's one real SD Refund entry (it carries its
     own offLeaseId — refunds.service.js's _mapRow) get attached to BOTH
     rows, painting Kirloskar's chips with Zenfold's live HOD/CEO status
     even though Kirloskar never reached Stage 6 at all. Same bug class as
     offlease.service.js's _lookupStage9OrderNos requireClientMatch fix —
     a container number alone is never a safe join key in this app.
     Falls back to the OLD container-only match ONLY when this container has
     exactly ONE Off-Lease Tracking row to begin with (legacy refund entries
     submitted before offLeaseId was captured have nowhere to leak onto —
     there's only one row they could possibly belong to). Checking the
     REFUND row count instead was tried first and is WRONG: live-verified on
     TRIU6617353, which has exactly one refund row (so that condition says
     "safe to fall back") but TWO Off-Lease Tracking rows — the fallback
     would still have leaked OF0090's refund onto OF0048. It's the number of
     ITEMS sharing a container that determines whether a container-only
     match can ever be ambiguous, not the number of refund rows. */
  const refundByContainer = useMemo(() => {
    const byComposite = new Map();
    const byContainerSingle = new Map();
    const isBetter = (existing) => !existing || existing.currentStage === 'done' || existing.currentStage === 'rejected';
    for (const r of refundRows || []) {
      const container = String(r.containerNo || '').trim().toUpperCase();
      if (!container) continue;
      const leaseId = String(r.offLeaseId || '').trim().toUpperCase();
      if (leaseId) {
        const key = `${container}|${leaseId}`;
        if (isBetter(byComposite.get(key))) byComposite.set(key, r);
      }
      if (isBetter(byContainerSingle.get(container))) byContainerSingle.set(container, r);
    }
    return { byComposite, byContainerSingle };
  }, [refundRows]);

  const itemsByContainerCount = useMemo(() => {
    const counts = new Map();
    for (const it of items) {
      const c = String(it.container || '').trim().toUpperCase();
      if (c) counts.set(c, (counts.get(c) || 0) + 1);
    }
    return counts;
  }, [items]);

  /* Same composite container+Lease-ID matching as refundByContainer above
     (see that block's own doc comment for the cross-lease bug this guards
     against) — tatRecords (offLeaseTatTracking.service.js's own records,
     one per Off-Lease Tracking row) each already carry their own
     containerNo/leaseId, so no "isBetter" merge is needed, just a direct
     composite key. */
  const tatByContainer = useMemo(() => {
    const byComposite = new Map();
    const byContainerSingle = new Map();
    for (const r of tatRecords || []) {
      const container = String(r.containerNo || '').trim().toUpperCase();
      if (!container) continue;
      const leaseId = String(r.leaseId || '').trim().toUpperCase();
      if (leaseId) byComposite.set(`${container}|${leaseId}`, r);
      if (!byContainerSingle.has(container)) byContainerSingle.set(container, r);
    }
    return { byComposite, byContainerSingle };
  }, [tatRecords]);

  const rows = useMemo(() => items.map((it) => {
    const container = String(it.container || '').trim().toUpperCase();
    const leaseId = String(it.leaseId || '').trim().toUpperCase();
    let refundEntry = leaseId ? refundByContainer.byComposite.get(`${container}|${leaseId}`) : undefined;
    if (!refundEntry && itemsByContainerCount.get(container) === 1) {
      refundEntry = refundByContainer.byContainerSingle.get(container);
    }
    let tatRecord = leaseId ? tatByContainer.byComposite.get(`${container}|${leaseId}`) : undefined;
    if (!tatRecord && itemsByContainerCount.get(container) === 1) {
      tatRecord = tatByContainer.byContainerSingle.get(container);
    }
    const status = statusOf(it, refundEntry);
    return { it, chips: buildChips(it, refundEntry, tatRecord), status, currentTat: currentTatStage(tatRecord, status.tatKey) };
  }), [items, refundByContainer, itemsByContainerCount, tatByContainer]);

  if (loading) return <SkeletonCards count={6} />;
  if (error) return <ErrorState message={error} onRetry={onRetry} />;
  if (!rows.length) {
    return <EmptyState message="No active off-lease containers" hint={searching ? 'Try a different search' : undefined} />;
  }

  return (
    <>
      <div className={styles.book}>
      {rows.map(({ it, chips, status, currentTat }) => (
        <div
          className={styles.row}
          key={`${it.leaseId || ''}-${it.container}`}
          role="button"
          tabIndex={0}
          onClick={() => onOpenRecord?.(it)}
          /* Only when the ROW ITSELF is focused. Without the target check this
             fired for every key event bubbling up from inside — typing a space
             in the remark editor opened the record. The row holds a text
             editor, buttons and a hover rail, so it must never claim keys
             pressed within them. */
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return;
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenRecord?.(it); }
          }}
        >
          <div className={styles.idCol}>
            <div className={styles.date}><Highlight text={it.deployedDate || '—'} query={highlight} /></div>
            <div className={styles.leaseId}><Highlight text={it.leaseId || '—'} query={highlight} /></div>
            <div className={styles.kind}>LEASE</div>
            {it.raisedBy && <div className={styles.owner}><Highlight text={it.raisedBy} query={highlight} /></div>}
          </div>

          <div className={styles.mainCol}>
            <div className={styles.clientRow}>
              <div className={styles.client}><Highlight text={it.clientName || 'Unknown client'} query={highlight} /></div>
              {/* Moved here from below the chips — explicit follow-up
                  2026-11-04 ("top client name right side the tat"): same
                  Entry/TAT/Delay text, now beside the client name instead
                  of its own line under the stage chips. */}
              {currentTat?.entryAt && (
                <span className={styles.currentTat}>
                  {currentTat.budgetLabel && <>TAT {currentTat.budgetLabel} · </>}
                  Entered {formatActionTimestamp(currentTat.entryAt)}
                  {currentTat.delayLabel && (
                    <> · <span className={currentTat.status === 'Delayed' ? styles.currentTatLate : styles.currentTatOk}>{currentTat.delayLabel}</span></>
                  )}
                </span>
              )}
              {/* Explicit request 2026-11-05 ("transporation stage 8 9 10
                  fetch... show the do create stage 9 in transit"), confirmed
                  display-only — the live FMS movement status for a container
                  currently at Stage 2 (Transportation), straight from
                  STAGE-8/9/10 (see getOffLeaseDashboardData's own
                  transportFms enrichment). Doesn't change when this stage
                  itself counts as done — still only real Stage 10 delivery
                  or a manual move, same as before. */}
              {it.transportFms?.status && (
                <span className={styles.currentTat}>
                  {it.transportFms.doNumber && <>DO {it.transportFms.doNumber} · </>}
                  <span className={it.transportFms.status === 'Delivered' ? styles.currentTatOk : styles.currentTat}>{it.transportFms.status}</span>
                </span>
              )}
            </div>
            {/* Spec, code and location on one line — three short values on
                three lines left a column of white space beside them. */}
            <div className={styles.meta}>
              <span><Highlight text={[it.size, it.type].filter(Boolean).join(' ') || 'Container'} query={highlight} /></span>
              {it.clientCode && <span className={styles.chipCode}><Highlight text={it.clientCode} query={highlight} /></span>}
              {it.location && (
                <span className={styles.location}>
                  <Icon name="pin" className={styles.locationIcon} />
                  <Highlight text={it.location} query={highlight} />
                </span>
              )}
            </div>

            <div className={styles.strip}>
              {chips.map((c) => {
                /* A real stage chip (c.stageNumber set) opens that STAGE'S
                   OWN form for THIS record -- editable only while it is the
                   current stage, view-only once done, locked while future.
                   The gate chip has no form of its own (approval is a
                   two-button decision, not a set of fields), so it keeps
                   jumping to the Approval tab, same as the status pill --
                   only while it is actually the thing waiting on someone. */
                const clickable = c.stageNumber != null ? c.tone !== 'future' : c.tone === 'current';
                if (!clickable) {
                  return (
                    <span key={c.key} className={`${styles.chip} ${styles[c.tone]}`} title={c.title}>
                      {c.label}
                    </span>
                  );
                }
                return (
                  <button
                    key={c.key}
                    type="button"
                    className={`${styles.chip} ${styles[c.tone]} ${styles.chipLink}`}
                    title={c.title}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (c.stageNumber != null) openStageChip(it.container, c, it._rowNum);
                      else onOpenTab?.(c.tab);
                    }}
                  >
                    {c.label}
                  </button>
                );
              })}
              {status.tab ? (
                <button
                  type="button"
                  className={`${styles.status} ${styles[status.tone]} ${styles.statusLink}`}
                  onClick={(e) => { e.stopPropagation(); onOpenTab?.(status.tab); }}
                >
                  {status.label}
                </button>
              ) : (
                <span className={`${styles.status} ${styles[status.tone]}`}>{status.label}</span>
              )}
            </div>
          </div>

          <RemarkCell item={it} onSaved={onRemarkSaved} />

          <div className={styles.sideCol}>
            <div className={styles.sideLabel}>Container</div>
            <div className={styles.containerNo}>
              <Icon name="container" className={styles.containerIcon} />
              <span><Highlight text={it.container} query={highlight} /></span>
            </div>
            <div className={styles.sideLabel}>Valid upto</div>
            <div className={styles.sideValue}><Highlight text={it.validUpto || '—'} query={highlight} /></div>
          </div>
        </div>
      ))}
    </div>

      {stageForm && (
        <StageDetailModal
          stageNumber={stageForm.stageNumber}
          containerNo={stageForm.container}
          rowNum={stageForm.rowNum}
          readOnly={stageForm.readOnly}
          identityOnly={stageForm.identityOnly}
          onClose={() => setStageForm(null)}
          onSaved={() => { setStageForm(null); onStageSaved?.(); }}
        />
      )}
    </>
  );
}
