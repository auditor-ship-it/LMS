/**
 * The 8 Off-Lease stages — labels match the existing app's OL_STAGE_INFO /
 * offlease.service.js exactly. `owner` matches CARD_OWNER's olStage1..7 in
 * the original app's frontend/src/pages/myTask/MyTaskPage.jsx (Stage 8 has
 * no assigned owner there either).
 */
export const STAGES = [
  { number: 1, label: 'Off-Lease Intimation', owner: 'Yastika' },
  { number: 2, label: 'Lifting / Arrival', owner: 'Kshirod Khatua' },
  { number: 3, label: 'Inspection Checklist', owner: 'Sitaram' },
  { number: 4, label: 'Quotation / Order', owner: 'Sitaram' },
  { number: 5, label: 'Billing Reconciliation', owner: 'Shivani Maam' },
  { number: 6, label: 'Transportation', owner: 'Kshirod Khatua' },
  { number: 7, label: 'Get In', owner: 'Pritam' },
  { number: 8, label: 'FMS Closure' }
];
