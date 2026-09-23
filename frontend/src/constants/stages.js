/**
 * The Off-Lease stages — labels match the existing app's OL_STAGE_INFO /
 * offlease.service.js exactly. `owner` matches CARD_OWNER's olStage1..7 in
 * the original app's frontend/src/pages/myTask/MyTaskPage.jsx (Stage 8 has
 * no assigned owner there either).
 */
/**
 * Every stage the sheet has columns for, including retired ones. Keyed by
 * `number`, which is the stage's column-range identity on the backend and
 * never renumbers — retiring a stage leaves a gap rather than shifting the
 * ones after it.
 */
export const ALL_STAGES = [
  { number: 1, label: 'Off-Lease Intimation', owner: 'Christopher' },
  { number: 2, label: 'Lifting / Arrival', owner: 'Kshirod Khatua', retired: true },
  { number: 3, label: 'Inspection Checklist', owner: 'Sitaram' },
  { number: 4, label: 'Quotation / Order', owner: 'Sitaram', retired: true },
  // RENAMED 2026-09-18 (explicit request): 'Billing Reconciliation' -> 'Final Billing'.
  { number: 5, label: 'Final Billing', owner: 'Shivani' },
  { number: 6, label: 'Transportation', owner: 'Kshirod Khatua' },
  { number: 7, label: 'Gate In', owner: 'Pritam' },
  // RENAMED 2026-09-18 (explicit request): 'FMS Closure' -> 'KAM', owner added ('Sales').
  { number: 8, label: 'KAM', owner: 'Sales' },
  /* ADDED 2026-09-18 (explicit request) as a genuinely new stage between
     Transportation and Gate In, displaying as "Stage 3" — LR details fetched
     live from FMS plus the Return Transportation PO fields. RETIRED
     2026-09-22 (explicit request), 4 days later: taken back out of the
     workflow entirely, LR reference + Invoice fields gone, not moved
     anywhere (the PO fields moved back to Stage 1, where they started).
     Kept here, like 2 and 4, only so a container that already completed it
     before removal still labels correctly on the container report. */
  { number: 10, label: 'LR & Return Transportation', owner: 'Shivani', retired: true }
];

/**
 * The live workflow — Stage 4 (Quotation / Order) was retired 2026-08-10, so
 * a container goes straight from Stage 3 (Inspection Checklist) to Stage 5
 * (Final Billing). Mirrors OL_RETIRED_STAGES in
 * backend/src/services/offlease.service.js.
 *
 * Use this for tabs, the pipeline board and anything that offers a stage for
 * work. Use ALL_STAGES only to label historical data.
 */
/**
 * `display` is the number users see, so the workflow reads 1..7 with no gap
 * where Stage 4 used to be. DISPLAY ONLY — `number` stays the stage's
 * identity: it picks the sheet column range, the offlease1..8/10 permission
 * key and the /stages/:n route. Never feed a display number back into either.
 *
 * "Stage 1A (Approval)" is NOT in this array — it's a synthetic tab hand-
 * built in OffLeasePage.jsx/OrderBookView.jsx (a filtered view of Stage 1's
 * own row, not a stage of its own), inserted right after Stage 1 without
 * consuming a numbered slot.
 */
/**
 * The live workflow IN ORDER — 1 Intimation, 2 Transportation, 3 Gate In,
 * 4 Inspection, 5 Final Billing, 6 KAM, with the Approval gate (1A) between
 * Stage 1 and Stage 2. Listed by internal number because that is each
 * stage's identity; the array order sets the sequence and the displayed
 * number.
 *
 * Gate In (internal 7) and Inspection (internal 3) swapped on 2026-08-12: a
 * container is inspected AFTER it is received, not before. Must stay in step
 * with OL_ACTIVE_STAGE_NUMS in backend/src/services/offlease.service.js.
 *
 * Retired and therefore absent: 2 (Lifting / Arrival), 4 (Quotation /
 * Order), and 10 (LR & Return Transportation — real stage 2026-09-18 to
 * 2026-09-22, retired again). Their data is preserved and still shown on the
 * container report.
 */
const WORKFLOW = [1, 6, 7, 3, 5, 8];

/**
 * Stages that are READ ONLY — the grid is shown (searchable, sortable,
 * paginated) but there is no form, no Open action and nothing to submit.
 *
 * Stage 2 (internal 6, Transportation) is the master list of pending off-lease
 * containers. Movements against those containers are entered in Stage 9, which
 * reads this same list; Stage 2 itself is only ever looked at.
 *
 * Distinct from `retired`: a retired stage leaves the workflow altogether,
 * whereas this one keeps its place, its number and its queue.
 */
export const READ_ONLY_STAGES = new Set([6]);
export const isReadOnlyStage = (n) => READ_ONLY_STAGES.has(Number(n));

export const STAGES = WORKFLOW
  .map((n) => ALL_STAGES.find((s) => s.number === n))
  .filter(Boolean)
  .map((s, i) => ({ ...s, display: i + 1 }));

/** Display number for an internal stage number; null for a retired stage,
 *  which has no place in the sequence. */
export function stageDisplayNumber(number) {
  return STAGES.find((s) => s.number === number)?.display ?? null;
}

/** "Stage 4 — Gate In", or "Quotation / Order (retired)". */
export function stageCaption(number, separator = '—') {
  const stage = ALL_STAGES.find((s) => s.number === number);
  const display = stageDisplayNumber(number);
  const label = stage?.label || '';
  return display ? `Stage ${display} ${separator} ${label}` : `${label} (retired)`;
}
