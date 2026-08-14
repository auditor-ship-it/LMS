/**
 * The 8 Off-Lease stages — labels match the existing app's OL_STAGE_INFO /
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
  { number: 1, label: 'Off-Lease Intimation', owner: 'Yastika' },
  { number: 2, label: 'Lifting / Arrival', owner: 'Kshirod Khatua', retired: true },
  { number: 3, label: 'Inspection Checklist', owner: 'Sitaram' },
  { number: 4, label: 'Quotation / Order', owner: 'Sitaram', retired: true },
  { number: 5, label: 'Billing Reconciliation', owner: 'Shivani Maam' },
  { number: 6, label: 'Transportation', owner: 'Kshirod Khatua' },
  { number: 7, label: 'Gate In', owner: 'Pritam' },
  { number: 8, label: 'FMS Closure' }
];

/**
 * The live workflow — Stage 4 (Quotation / Order) was retired 2026-08-10, so
 * a container goes straight from Stage 3 (Inspection Checklist) to Stage 5
 * (Billing Reconciliation). Mirrors OL_RETIRED_STAGES in
 * backend/src/services/offlease.service.js.
 *
 * Use this for tabs, the pipeline board and anything that offers a stage for
 * work. Use ALL_STAGES only to label historical data.
 */
/**
 * `display` is the number users see, so the workflow reads 1..7 with no gap
 * where Stage 4 used to be — Billing Reconciliation is internally stage 5 and
 * shows as "Stage 4".
 *
 * DISPLAY ONLY. `number` stays the stage's identity: it picks the sheet
 * column range, the offlease1..8 permission key and the /stages/:n route.
 * Never feed a display number back into any of those.
 */
/**
 * The live workflow IN ORDER — 1 Intimation, 2 Transportation, 3 Gate In,
 * 4 Inspection, 5 Billing Reconciliation, 6 FMS Closure, with the Approval
 * gate after Stage 1. Listed by internal number because that is each stage's
 * identity; the array order sets the sequence and the displayed number.
 *
 * Gate In (internal 7) and Inspection (internal 3) swapped on 2026-08-12: a
 * container is inspected AFTER it is received, not before. Must stay in step
 * with OL_ACTIVE_STAGE_NUMS in backend/src/services/offlease.service.js.
 *
 * Retired and therefore absent: 2 (Lifting / Arrival) and 4 (Quotation /
 * Order). Their data is preserved and still shown on the container report.
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

/** "Stage 4 — Billing Reconciliation", or "Quotation / Order (retired)". */
export function stageCaption(number, separator = '—') {
  const stage = ALL_STAGES.find((s) => s.number === number);
  const display = stageDisplayNumber(number);
  const label = stage?.label || '';
  return display ? `Stage ${display} ${separator} ${label}` : `${label} (retired)`;
}
