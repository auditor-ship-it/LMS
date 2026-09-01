/**
 * Per-stage field definitions for the Off-Lease 8-stage pipeline.
 *
 * This is this app's OWN copy of the field map — ported field-for-field from
 * the main app's frontend/src/pages/offLease/stageFields.js (the verified
 * source of truth, cross-checked there against backend/src/services/
 * offlease.service.js's OL_HEADERS / OL_STAGE_INFO). Kept as a separate file
 * here since this app is an independent Vite project that doesn't import
 * from frontend/ except via the shared auth module.
 *
 * RULES (do not violate — wrong fields silently corrupt the production sheet):
 *  - Only the `key` (col_N) values listed here for a given stage may be sent
 *    in the POST /offlease/:rowNum/stage/:stage body.
 *  - Never include the trailing Timestamp/User/Status triplet of any stage
 *    range — the backend always overwrites those itself.
 *  - Stage 3: columns col_133/134/135 ("Photo: Left/Right/Back Side") are a
 *    documented header collision with an unrelated hidden sync feature and
 *    are deliberately excluded; only col_136-141 are real Stage-3 photos.
 *  - Stage 1: col_1 (Lease ID) is never sent — it's server-assigned.
 *
 * field.type one of: text | number | date | datetime | select | selectOther | radio | file | textarea
 * field.showIf(values) — optional, hides the field (and its requirement) unless true.
 * field.inspection — optional {n, item, role}; marks a field as part of the
 *   Stage 3 inspection checklist so StageDetailModal renders it inside the
 *   Good/Damage table instead of the plain field grid. Purely presentational:
 *   these are ordinary fields for validation and submit purposes.
 */

const YES_NO = ['Yes', 'No'];
const YES_NO_MAYBE = ['Yes', 'No', 'Maybe'];
/* Every inspection point is Good or Damage. Point 11 (Mantrap) additionally
   offers "Not Required", since it is the one fitting that legitimately may not
   apply to a container — the others are structural and always have to be
   assessed. Only "Damage" opens the estimate/photo/remarks fields. */
const INSPECTION_STATUS = ['Good', 'Damage'];
const INSPECTION_STATUS_OPTIONAL = ['Good', 'Damage', 'Not Required'];
/* Several points record HOW they failed, not just that they did. */
const GASKET_STATUS = ['Good', 'Cut', 'Missing', 'Damage'];
const COIL_STATUS = ['Good', 'Damage', 'Rusty', 'Leak'];
const CABLE_STATUS = ['OK', 'Damage', 'Missing', 'Short'];
const MOTOR_STATUS = ['Good', 'Noisy', 'Faulty'];
const CONTRACTOR_STATUS = ['Good', 'Missing', 'Damage'];
const ISO_PLUG_STATUS = ['Good', 'Safety Pin Cut', 'Missing'];

/**
 * A status meaning the point is sound, or that it doesn't apply. Everything
 * else — Damage, Rusty, Leak, Short, Noisy, Faulty, Cut, Missing, Safety Pin
 * Cut — is a fault and opens the estimate / photo / remarks fields.
 *
 * Derived this way rather than listing the triggers per point, so adding a new
 * failure wording to a point's options can't silently forget to open them.
 */
export const SOUND_STATUSES = ['good', 'ok'];
export const NEUTRAL_STATUSES = ['not required'];
export function isFaultStatus(status) {
  const s = String(status || '').trim().toLowerCase();
  return s !== '' && !SOUND_STATUSES.includes(s) && !NEUTRAL_STATUSES.includes(s);
}

/** A container is Reefer unless its Type says otherwise. Type is col_3, which
 *  the stage-detail endpoint returns as read-only context. */
const isReefer = (v) => String(v.col_3 || '').trim().toLowerCase().includes('reefer');

const quotationShown = (v) => String(v.col_164 || '').toLowerCase() === 'yes';

/**
 * Stage 3 inspection checklist — the 8 container inspection points from the
 * printed instruction sheet, plus Curtain / Tube Light / Mantrap.
 *
 * `base` is the 0-based sheet column of that item's Status cell; Estimate is
 * base+1 and Photo is base+2. `remark` is a separate index because the remark
 * columns were appended after the Status/Estimate/Photo block had already
 * been written to the live header row — see the matching comment in
 * backend/src/services/offlease.service.js.
 *
 * These MUST stay in step with the 'Insp ...' headers in that file
 * (168..200 and 201..211) — the backend writes whatever col_N it is sent, so
 * a wrong index here writes to the wrong column silently.
 */
const INSPECTION_POINTS = [
  { item: 'Outside / Undercarriage', base: 136, remark: 169 },
  { item: 'Inside and Outside Doors', base: 139, remark: 170 },
  { item: 'Right Side', base: 142, remark: 171 },
  { item: 'Left Side', base: 145, remark: 172 },
  { item: 'Front Wall', base: 148, remark: 173 },
  { item: 'Ceiling / Roof', base: 151, remark: 174 },
  { item: 'Floor (Inside)', base: 154, remark: 175 },
  { item: 'Contamination', base: 157, remark: 176 },
  // Displays as point 9; its columns sit at the end because it was added
  // after the rest — see OL_INSPECTION_DEFS on the backend.
  { item: 'Gasket Door', base: 222, remark: 225, options: GASKET_STATUS },
  { item: 'Curtain', base: 160, remark: 177, reeferOnly: true },
  { item: 'Tube Light', base: 163, remark: 178, reeferOnly: true },
  { item: 'Mantrap', base: 166, remark: 179, optional: true, reeferOnly: true }
];

/**
 * Reefer Machine Check — ten machine points, shown for every container.
 * Unlike the inspection block these are four consecutive columns each, except
 * that point 10 jumps index 249: that column holds a legacy "Marked" value in
 * live rows and must not be written. Mirrors OL_MACHINE_BASES in
 * backend/src/services/offlease.service.js.
 */
const MACHINE_POINTS = [
  { item: 'Compressor', base: 180 },
  { item: 'Condenser Coil', base: 184, options: COIL_STATUS },
  { item: 'Evaporator Coil', base: 188, options: COIL_STATUS },
  { item: 'Condenser Fan', base: 192 },
  { item: 'Evaporator Fan', base: 196 },
  { item: 'Controller / Microprocessor', base: 200 },
  { item: 'Power Cable & Plug', base: 204 },
  { item: 'Refrigerant Gas Charge', base: 208 },
  { item: 'Temperature Sensors / Probes', base: 212 },
  { item: 'Defrost System', base: 218 },
  // Added later, so their columns sit at 258+ rather than being interleaved.
  { item: 'Cable 4 Core 4mm 18Mtr', base: 226, options: CABLE_STATUS },
  { item: 'Motor Condition', base: 230, options: MOTOR_STATUS },
  { item: 'Contractor', base: 234, options: CONTRACTOR_STATUS },
  { item: 'ISO Plug', base: 238, options: ISO_PLUG_STATUS }
];

/**
 * Site Cabin fittings inventory — a different shape from the condition
 * checklists: each row is an expected quantity against the quantity actually
 * found. Mirrors OL_CABIN_ITEMS in offlease.service.js; `qty` is a spec per
 * cabin size, so only "available" is stored.
 *
 * 20FT quantities are from the supplied cabin sheet. A size with no entry
 * shows a blank expected quantity rather than a wrong one.
 */
const CABIN_ITEMS = [
  { item: 'Fan', col: 244, qty: { '20FT': 3 } },
  { item: 'LED', col: 245, qty: { '20FT': 4 } },
  { item: '5 Amp Switch', col: 246, qty: { '20FT': 2 } },
  { item: 'Window', col: 247, qty: { '20FT': 2 } },
  { item: '15A Switch', col: 248, qty: { '20FT': 1 } },
  { item: 'Bulkhead', col: 249, qty: { '20FT': 1 } },
  { item: 'AC point', col: 250, qty: { '20FT': 1 } },
  { item: 'MCB', col: 251, qty: { '20FT': 1 } },
  { item: 'Manager Table', col: 252, qty: { '20FT': 1 } },
  { item: 'Table', col: 253, qty: { '20FT': 4 } },
  { item: 'Overhead Storage', col: 254, qty: { '20FT': 4 } },
  { item: 'Chair', col: 255, qty: { '20FT': 7 } },
  { item: 'Partition', col: 256, qty: { '20FT': 1 } }
];

/** Site Cabin is a container Type (see Stage 6's Container Type options). */
const isSiteCabin = (v) => String(v.col_3 || '').trim().toLowerCase().includes('site cabin');
/** Size normalised for the qty lookup — "20 ft" / "20FT" both key as 20FT. */
export const normaliseSize = (s) => String(s || '').trim().toUpperCase().replace(/\s+/g, '');
export const cabinExpectedQty = (entry, size) => entry.qty[normaliseSize(size)] ?? '';

const CABIN_FIELDS = CABIN_ITEMS.map((c, i) => ({
  key: `col_${c.col}`,
  label: c.item,
  type: 'number',
  showIf: isSiteCabin,
  cabin: { n: i + 1, item: c.item, qty: c.qty }
}));

/** Technician labour — hours entered here, cost derived server-side at this
 *  rate (see OL_TECHNICIAN_RATE_PER_HOUR in offlease.service.js). */
export const TECHNICIAN_RATE_PER_HOUR = 1000;
const TECHNICIAN_HOURS_KEY = 'col_242';
const TECHNICIAN_COST_KEY = 'col_243';

/**
 * Builds the four fields for one checklist point. Estimate, Photo and Remark
 * appear only once that point is marked Damage. `remarkCol` is separate
 * because the inspection block's remarks were appended after its
 * Status/Estimate/Photo columns had already been written.
 */
function checklistFields({ group, n, item, base, remarkCol, options, reeferOnly = false }) {
  const statusKey = `col_${base}`;
  const applies = reeferOnly ? isReefer : () => true;
  // The point itself is hidden for Dry when reeferOnly; its detail fields need
  // BOTH conditions, or they would surface on a Dry container whose status
  // column still holds a value from before the type was corrected.
  const needsDetail = (v) => applies(v) && isFaultStatus(v[statusKey]);
  const meta = (role) => ({ group, n, item, role });
  return [
    { key: statusKey, label: item, type: 'radio', options, showIf: reeferOnly ? applies : undefined, inspection: meta('status') },
    { key: `col_${base + 1}`, label: `${item} — Estimate Value`, type: 'number', showIf: needsDetail, inspection: meta('estimate') },
    { key: `col_${base + 2}`, label: `${item} — Photo`, type: 'file', showIf: needsDetail, inspection: meta('photo') },
    { key: `col_${remarkCol}`, label: `${item} — Remarks`, type: 'text', showIf: needsDetail, inspection: meta('remark') }
  ];
}

const INSPECTION_FIELDS = INSPECTION_POINTS.flatMap(({ item, base, remark, optional, options, detailOn, reeferOnly }, i) =>
  checklistFields({
    group: 'inspection',
    n: i + 1,
    item,
    base,
    remarkCol: remark,
    options: options || (optional ? INSPECTION_STATUS_OPTIONAL : INSPECTION_STATUS),
    detailOn,
    reeferOnly
  })
);

/* The whole Machine Check is Reefer-only — a Dry container has no machine. */
const MACHINE_FIELDS = [
  ...MACHINE_POINTS.flatMap(({ item, base, options }, i) =>
    checklistFields({
      group: 'machine',
      n: i + 1,
      item,
      base,
      remarkCol: base + 3,
      options: options || INSPECTION_STATUS,
      reeferOnly: true
    })
  ),
  /* Labour, not a condition — a plain input under the table rather than a
     checklist row. Cost is written by the server from these hours, so it is
     shown read-only and never submitted. */
  {
    key: TECHNICIAN_HOURS_KEY,
    label: `Technician Hours (@ ${TECHNICIAN_RATE_PER_HOUR}/hr)`,
    type: 'number',
    showIf: isReefer,
    footerOf: 'machine'
  },
  {
    key: TECHNICIAN_COST_KEY,
    label: 'Technician Cost',
    type: 'computed',
    compute: (v) => {
      const h = Number(String(v[TECHNICIAN_HOURS_KEY] ?? '').trim());
      return Number.isFinite(h) && String(v[TECHNICIAN_HOURS_KEY] ?? '').trim() !== ''
        ? h * TECHNICIAN_RATE_PER_HOUR
        : '';
    },
    showIf: isReefer,
    footerOf: 'machine'
  }
];

export const STAGE_FIELDS = {
  1: [
    { key: 'col_10', label: 'Off-Lease Intimation Date', type: 'date', required: true },
    { key: 'col_11', label: 'Off-Lease Date', type: 'date', required: true },
    { key: 'col_12', label: 'Email Notification', type: 'file' },
    { key: 'col_13', label: 'Final Billing Date', type: 'date', required: true },
    { key: 'col_14', label: 'Remark', type: 'text' }
  ],

  2: [
    { key: 'col_18', label: 'Lifting Date', type: 'date', required: true },
    { key: 'col_19', label: 'Arrival Date', type: 'date', required: true },
    { key: 'col_20', label: 'Remark', type: 'text' }
  ],

  /* The old Yes/No/Maybe checklist (col_25..col_35), Checklist drawing /
     Estimate If any / Estimate Cost / Remark (col_36..col_39) and the six
     fixed photo slots (col_136..col_141) were removed once the inspection
     table below replaced them: it captures the same condition assessment
     per inspection point, with the estimate and photo attached to the
     specific item that is damaged rather than to the stage as a whole.

     Those columns are NOT deleted from the sheet and are still inside Stage
     3's col range, so getOffLeaseContainerDetail() keeps reporting whatever
     historical rows already hold — the container lookup and its PDF still
     show them. They are simply no longer offered for new entry. */
  3: [
    { key: 'col_24', label: 'Container Received Date', type: 'date', required: true },
    ...INSPECTION_FIELDS,
    ...MACHINE_FIELDS,
    ...CABIN_FIELDS
  ],

  4: [
    { key: 'col_164', label: 'Quotation Create?', type: 'radio', options: YES_NO },
    { key: 'col_59', label: 'Quotation Number', type: 'text', required: true, showIf: quotationShown },
    { key: 'col_60', label: 'Order Received Number', type: 'text', required: true, showIf: quotationShown },
    { key: 'col_167', label: 'Email (for quotation notice)', type: 'text', showIf: quotationShown },
    /* Quotation File (col_165) was removed from this form — the Stage 3
       inspection report supersedes attaching a file by hand here. The column
       stays in OL_STAGE4_EXTRA_COLS on the backend, so historical values still
       appear in the container lookup and its PDF; it is simply no longer
       offered for new entry. */
    { key: 'col_166', label: 'Quotation Amount', type: 'number', required: true, showIf: quotationShown },
    { key: 'col_61', label: 'Delivery Order Required?', type: 'radio', options: YES_NO, showIf: quotationShown },
    { key: 'col_62', label: 'Remark', type: 'text' }
  ],

  /* col_305-316, NOT col_43-55 — those collided with Stage 5's own
     Remark/Timestamp/User/Status write-back (col_41-44) and with Stage 6's
     own field range (starts col_45); see OL_STAGE5_EXTRA_COLS's doc comment
     in offlease.service.js for the full story. Must stay in step with that
     array — same slots, same order (col_313/314, Accrued Rental Amount/Date,
     removed from the form per request but left dormant on the backend, same
     as Move To Stage's Arrival Date — see that column's own comment). */
  5: [
    { key: 'col_305', label: 'Check if rentals are billed up to the last date', type: 'radio', options: YES_NO },
    { key: 'col_306', label: 'Outstanding Amount', type: 'number' },
    { key: 'col_307', label: 'Date - Billed Till', type: 'date' },
    { key: 'col_308', label: 'Estimated repair charges billed', type: 'text' },
    { key: 'col_309', label: 'Transport cost is billed', type: 'radio', options: YES_NO },
    { key: 'col_310', label: 'Adjust Security Deposit if applicable', type: 'radio', options: YES_NO },
    { key: 'col_311', label: 'Security Deposit Amount', type: 'number' },
    { key: 'col_312', label: 'Last Date Of Billing', type: 'date' },
    { key: 'col_315', label: 'Reconcile entire billing cycle', type: 'radio', options: YES_NO },
    { key: 'col_316', label: 'Remark', type: 'text' }
  ],

  6: [
    { key: 'col_66', label: 'User', type: 'text' },
    { key: 'col_67', label: 'Vehicle Placed By', type: 'select', options: ['Client', 'Crystal'] },
    { key: 'col_68', label: 'Quotation Number', type: 'text', required: true },
    { key: 'col_69', label: 'Order Received Number', type: 'text', required: true },
    { key: 'col_70', label: 'DO Number', type: 'text', required: true },
    { key: 'col_71', label: 'Vehicle No', type: 'text', required: true },
    { key: 'col_72', label: 'Cash Memo Number', type: 'text', required: true },
    { key: 'col_73', label: 'Cash Memo Date', type: 'date' },
    { key: 'col_74', label: 'Cash Memo Received Date', type: 'date' },
    { key: 'col_75', label: 'Vehicle Reached at Pick-up Location', type: 'datetime' },
    { key: 'col_76', label: 'Loading City', type: 'text', required: true },
    { key: 'col_77', label: 'Destination City', type: 'text', required: true },
    { key: 'col_78', label: 'Loading Date', type: 'date' },
    { key: 'col_79', label: 'Transit Days', type: 'number' },
    { key: 'col_80', label: 'Km', type: 'number' },
    { key: 'col_81', label: 'Expected Delivery Date', type: 'date' },
    { key: 'col_82', label: 'Size', type: 'selectOther', options: ['10FT', '20FT', '40FT'] },
    { key: 'col_83', label: 'Container Type', type: 'selectOther', options: ['Dry Container', 'Reefer Container', 'Site Cabin', 'ISO Tank', 'Office Container', 'Blast Container', 'Superstore'] },
    { key: 'col_84', label: 'Quantity', type: 'selectOther', options: ['1', '2', '3', '4'] },
    { key: 'col_85', label: 'Vehicle Type', type: 'select', options: ['20ft Trailer', '40ft Trailer', 'Other'] },
    { key: 'col_86', label: 'Movement Type', type: 'select', options: ['Internal Movement (Depot to Depot)', 'Offlease', 'Lease', 'Sale'] },
    { key: 'col_87', label: 'Transportation Type', type: 'select', options: ['Empty', 'Loaded', 'Cabotage'] },
    { key: 'col_88', label: 'Container Number', type: 'text' },
    { key: 'col_89', label: 'WT', type: 'text' },
    { key: 'col_90', label: 'Pick-up Address', type: 'text', required: true },
    { key: 'col_91', label: 'Delivery Address', type: 'text', required: true },
    { key: 'col_92', label: 'Delivery Pin Code', type: 'text' },
    { key: 'col_93', label: 'Customer Name', type: 'text' },
    { key: 'col_94', label: 'Driver Photo', type: 'file' },
    { key: 'col_95', label: 'Payment Type', type: 'select', options: ['Advance', 'Balance', 'Full Payment', 'On A/C Payment'] },
    { key: 'col_96', label: 'Payment Terms', type: 'text' },
    { key: 'col_97', label: 'Immediate Payment', type: 'select', options: ['1-7 Days', '7-15 Days', '15-21 Days', '21-30 Days', '30 & Above'] },
    { key: 'col_98', label: 'Payment Due Date', type: 'date' },
    { key: 'col_99', label: 'Other Charges [Loading/Crane/Labor]', type: 'number' },
    { key: 'col_100', label: 'Detention Charge at Loading Point', type: 'number' },
    { key: 'col_101', label: 'Less Late Delivery Amount', type: 'number' },
    { key: 'col_102', label: 'Crane / Hydra Charge', type: 'number' },
    { key: 'col_103', label: 'Unloading Labour Charge', type: 'number' },
    { key: 'col_104', label: 'Cleaning Charge', type: 'number' },
    { key: 'col_105', label: 'Collection Memo', type: 'file' },
    { key: 'col_106', label: 'LR Scanned Copy', type: 'file' },
    { key: 'col_107', label: 'Vehicle Name Plate Photo', type: 'file' },
    { key: 'col_108', label: 'Container Photo (with number visible)', type: 'file' },
    { key: 'col_109', label: 'Door Photo with Seal', type: 'file' },
    { key: 'col_110', label: 'Inside full view', type: 'file' },
    { key: 'col_111', label: 'Machine Photo with Power Cable & Keypad', type: 'file' },
    { key: 'col_112', label: 'Full Video All Sides', type: 'file' },
    { key: 'col_113', label: 'Bill', type: 'file' },
    { key: 'col_114', label: 'Driving Licence', type: 'file' },
    { key: 'col_115', label: 'RC Book', type: 'file' },
    { key: 'col_116', label: 'Transporter Name', type: 'text' },
    { key: 'col_117', label: 'Freight Cost', type: 'number' },
    { key: 'col_118', label: 'Remarks', type: 'textarea' }
  ],

  /* Gate Entry form removed 2026-08-24: gate/depot staff already fill out a
     separate Google Form (the "Stage 3 " tab, read by
     backend/src/services/stage3Form.service.js) for every container's Gate
     Status, Date, Location, Transporter, Container Photos, and Repair
     Required — asking for all of it again here was pure duplication. The
     app now reads that form directly and treats a container as gated in
     the moment it shows "Inward (Gate-In)"; a "Repair Required? = No" row
     also skips Stage 4 (Inspection Checklist) entirely. Nothing left to
     submit here — see StageDetailModal.jsx's empty-fields message. */
  7: [],

  8: [
    { key: 'col_122', label: 'Billing & Filing', type: 'file' },
    { key: 'col_123', label: 'FMS Closure', type: 'file' },
    { key: 'col_124', label: 'All documents uploaded to FMS?', type: 'radio', options: YES_NO_MAYBE },
    { key: 'col_125', label: 'Remark', type: 'text' }
  ]
};

/** Base identity columns shown read-only at the top of every stage form (never submitted). */
export const BASE_FIELDS = [
  { key: 'col_0', label: 'Container No' },
  { key: 'col_1', label: 'Lease ID' },
  { key: 'col_2', label: 'Size' },
  { key: 'col_3', label: 'Type' },
  { key: 'col_5', label: 'Client Name' },
  { key: 'col_6', label: 'Location' },
  { key: 'col_7', label: 'Deployed Date' },
  { key: 'col_8', label: 'Valid Upto' }
];
