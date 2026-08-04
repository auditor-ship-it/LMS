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
 */

const YES_NO = ['Yes', 'No'];
const YES_NO_MAYBE = ['Yes', 'No', 'Maybe'];

const quotationShown = (v) => String(v.col_164 || '').toLowerCase() === 'yes';

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

  3: [
    { key: 'col_24', label: 'Container Received Date', type: 'date', required: true },
    { key: 'col_25', label: 'Internal cleaning completed?', type: 'radio', options: YES_NO_MAYBE },
    { key: 'col_26', label: 'External cleaning completed?', type: 'radio', options: YES_NO_MAYBE },
    { key: 'col_27', label: '18-meter wire intact (no cuts)?', type: 'radio', options: YES_NO_MAYBE },
    { key: 'col_28', label: 'Dents checked on all sides?', type: 'radio', options: YES_NO_MAYBE },
    { key: 'col_29', label: 'Paint condition verified?', type: 'radio', options: YES_NO },
    { key: 'col_30', label: 'Logo visibility intact?', type: 'radio', options: YES_NO_MAYBE },
    { key: 'col_31', label: 'Reefer machine cleaned?', type: 'radio', options: YES_NO_MAYBE },
    { key: 'col_32', label: 'Keypad display visible?', type: 'radio', options: YES_NO_MAYBE },
    { key: 'col_33', label: 'Short PTI done?', type: 'radio', options: YES_NO_MAYBE },
    { key: 'col_34', label: 'Estimation of work pending?', type: 'radio', options: YES_NO },
    { key: 'col_35', label: 'Technician checked', type: 'radio', options: YES_NO },
    { key: 'col_36', label: 'Checklist drawing', type: 'text' },
    { key: 'col_37', label: 'Estimate If any', type: 'text' },
    { key: 'col_38', label: 'Estimate Cost', type: 'number' },
    { key: 'col_39', label: 'Remark', type: 'text' },
    { key: 'col_136', label: 'Photo: Inside Front', type: 'file' },
    { key: 'col_137', label: 'Photo: Inside Rear', type: 'file' },
    { key: 'col_138', label: 'Photo: Roof', type: 'file' },
    { key: 'col_139', label: 'Photo: Floor', type: 'file' },
    { key: 'col_140', label: 'Photo: Door Lock', type: 'file' },
    { key: 'col_141', label: 'Photo: Container Close up', type: 'file' }
  ],

  4: [
    { key: 'col_164', label: 'Quotation Create?', type: 'radio', options: YES_NO },
    { key: 'col_59', label: 'Quotation Number', type: 'text', required: true, showIf: quotationShown },
    { key: 'col_60', label: 'Order Received Number', type: 'text', required: true, showIf: quotationShown },
    { key: 'col_167', label: 'Email (for quotation notice)', type: 'text', showIf: quotationShown },
    { key: 'col_165', label: 'Quotation File', type: 'file', required: true, showIf: quotationShown },
    { key: 'col_166', label: 'Quotation Amount', type: 'number', required: true, showIf: quotationShown },
    { key: 'col_61', label: 'Delivery Order Required?', type: 'radio', options: YES_NO, showIf: quotationShown },
    { key: 'col_62', label: 'Remark', type: 'text' }
  ],

  5: [
    { key: 'col_43', label: 'Check if rentals are billed up to the last date', type: 'radio', options: YES_NO },
    { key: 'col_44', label: 'Outstanding Amount', type: 'number' },
    { key: 'col_45', label: 'Date - Billed Till', type: 'date' },
    { key: 'col_46', label: 'Estimated repair charges billed', type: 'text' },
    { key: 'col_47', label: 'Transport cost is billed', type: 'radio', options: YES_NO },
    { key: 'col_48', label: 'Adjust Security Deposit if applicable', type: 'radio', options: YES_NO },
    { key: 'col_49', label: 'Security Deposit Amount', type: 'number' },
    { key: 'col_50', label: 'Last Date Of Billing', type: 'date' },
    { key: 'col_51', label: 'Accrued Rental Amount', type: 'number' },
    { key: 'col_52', label: 'Accrued Rental Amount Date', type: 'date' },
    { key: 'col_53', label: 'Reconcile entire billing cycle', type: 'radio', options: YES_NO },
    { key: 'col_54', label: 'Get approval from', type: 'select', options: ['Finance Head', 'Sales DGM', 'CEO'] },
    { key: 'col_55', label: 'Remark', type: 'text' }
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

  7: [
    { key: 'col_142', label: 'Gate Status', type: 'select', options: ['Inward (Gate-In)', 'Outward (Gate-Out)'] },
    { key: 'col_143', label: 'Gate Date', type: 'date', required: true },
    { key: 'col_144', label: 'Location', type: 'text', required: true },
    { key: 'col_145', label: 'Transporter Name', type: 'text', required: true },
    { key: 'col_146', label: 'Transporter Number', type: 'text' },
    { key: 'col_147', label: 'Vehicle Number', type: 'text', required: true },
    { key: 'col_148', label: 'LR Copy', type: 'file' },
    { key: 'col_149', label: 'Photo: Left Side', type: 'file' },
    { key: 'col_150', label: 'Photo: Right Side', type: 'file' },
    { key: 'col_151', label: 'Photo: Back View', type: 'file' },
    { key: 'col_152', label: 'Photo: Inside Front', type: 'file' },
    { key: 'col_153', label: 'Photo: Inside Rear', type: 'file' },
    { key: 'col_154', label: 'Photo: Roof', type: 'file' },
    { key: 'col_155', label: 'Photo: Floor', type: 'file' },
    { key: 'col_156', label: 'Photo: Door Lock', type: 'file' },
    { key: 'col_157', label: 'Photo: Container Close up', type: 'file' },
    { key: 'col_158', label: 'Repair Required?', type: 'radio', options: YES_NO },
    { key: 'col_159', label: 'Est. Budget', type: 'number' },
    { key: 'col_160', label: 'Remark', type: 'text' }
  ],

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
