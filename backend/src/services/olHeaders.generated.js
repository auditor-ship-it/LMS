/**
 * The Off-Lease Tracking header row, captured from the live sheet.
 *
 * GENERATED — do not hand-edit. Every column index in offlease.service.js is
 * positional, so this array must mirror row 1 exactly; a stale copy makes the
 * app read and write the wrong columns.
 *
 * Regenerate after ANY column is added, removed or moved in the sheet:
 *   node -e "import('./src/services/googleSheets.service.js').then(async m=>{ \
 *     const r=(await m.getRange('Off-Lease Tracking','A1:KZ1'))[0]||[]; \
 *     require('fs').writeFileSync('headers.json',JSON.stringify(r.map(h=>String(h??'').trim()))) })"
 *
 * Captured 289 columns on 2026-08-11, after the manual column
 * deletions. Indices 257..288 are a duplicated tail that _ensureOffLeaseSheet()
 * appended when the sheet was briefly narrower than this array; they carry no
 * data and nothing maps to them.
 *
 * Index 289 ("Source DO No") is a DELIBERATE, hand-added exception to the
 * "generated, do not hand-edit" rule above — added 2026-08-28 by the app
 * itself, not captured from an existing live column. It's the app's own new
 * bookkeeping field (see OL_SOURCE_DO_COL in offlease.service.js), written
 * once when a row is created automatically from a Stage 8 FMS "Offlease"
 * movement record, so a later sync can tell "already linked" from "new" by
 * DO number without re-scanning the whole external sheet. _ensureOffLeaseSheet()
 * widens the live sheet's header row to match this array already, so this
 * column gets created there automatically — no manual sheet edit needed. If
 * this file is ever regenerated from the live header row, keep this entry.
 *
 * Indices 290..297 ("Move To Stage ...") are the same kind of deliberate,
 * hand-added exception — added 2026-08-28 for the Stage 2 "Move To Stage" /
 * "Send Back" action (see OL_MOVE_REASON_COL etc. in offlease.service.js).
 * Recorded on the row itself rather than reusing the Transportation stage's
 * own status column (99, "Other Charges [Loading/Crane/Labor]" — a real
 * financial field, not a status flag). These 8 columns hold only the
 * CURRENT live move state and are cleared on Send Back; the permanent
 * audit trail lives in a separate append-only sheet — see
 * offleaseMoveHistory.service.js.
 */
export const OL_HEADERS = [
  "Container No", "Lease ID", "Size", "Type",
  "Client Code", "Client Name", "Location", "Deployed Date",
  "Valid Upto", "Rate", "OL Intimation Date", "OL Date",
  "Email Notification URL", "Final Billing Date", "Stage 1 Remark", "Stage 1 Timestamp",
  "Stage 1 User", "Stage 1 Status", "Lifting Date", "Arrival Date",
  "Stage 2 Remark", "Stage 2 Timestamp", "Stage 2 User", "Stage 2 Status",
  "Container Received Date", "Stage 3 Remark", "Stage 3 Timestamp", "Stage 3 User",
  "Stage 3 Status", "Rentals Billed Till Date", "Outstanding Amount", "Date Billed Till",
  "Est Repair Charges Billed", "Transport Cost Billed", "Adjust Security Deposit", "Security Deposit Amount",
  "Last Date Of Billing", "Accrued Rental Amount", "Accrued Rental Date", "Reconcile Billing Cycle",
  "Approval From", "Stage 4 Remark", "Stage 4 Timestamp", "Stage 4 User",
  "Stage 4 Status", "Vehicle Placed By", "Quotation Number", "Order Received Number",
  "DO Number", "Vehicle No", "Cash Memo Number", "Cash Memo Date",
  "Cash Memo Received Date", "Vehicle Reached at Pick-up", "Loading City", "Destination City",
  "Loading Date", "Transit Days", "Km", "Expected Delivery Date",
  "Size", "Container Type", "Quantity", "Vehicle Type",
  "Movement Type", "Transportation Type", "Container Number", "WT",
  "Pick-up Address", "Delivery Address", "Delivery Pin Code", "Customer Name",
  "Driver Photo", "Payment Type", "Payment Terms", "Immediate Payment",
  "Payment Due Date", "Other Charges", "Detention Charge", "Less Late Delivery",
  "Crane/Hydra Charge", "Unloading Labour", "Cleaning Charge", "Collection Memo",
  "LR Scanned Copy", "Vehicle Name Plate", "Container Photo", "Door Photo",
  "Inside Full View", "Machine Photo", "Full Video", "Bill",
  "Driving Licence", "RC Book", "Transporter Name", "Freight Cost",
  "Stage 6 Remark", "Stage 6 Timestamp", "Stage 6 User", "Stage 6 Status",
  "Billing & Filing", "FMS Closure", "All Docs Uploaded to FMS", "Stage 7 Remark",
  "Stage 7 Timestamp", "Stage 7 User", "Stage 7 Status", "Intimation Approval Status",
  "Intimation Approval Timestamp", "Intimation Approval User", "Intimation Approval Remarks", "Move to Container master",
  "Email ID", "Mail Status", "Gate Status", "Gate Date",
  "Gate Location", "Gate Transporter Name", "Gate Transporter Number", "Gate Vehicle Number",
  "Gate LR Copy", "Gate Photo: Left Side", "Gate Photo: Right Side", "Gate Photo: Back View",
  "Gate Photo: Inside Front", "Gate Photo: Inside Rear", "Gate Photo: Roof", "Gate Photo: Floor",
  "Gate Photo: Door Lock", "Gate Photo: Container Close Up", "Gate Repair Required", "Gate Est Budget",
  "Stage 8 Remark", "Stage 8 Timestamp", "Stage 8 User", "Stage 8 Status",
  "Insp Outside/Undercarriage Status", "Insp Outside/Undercarriage Estimate", "Insp Outside/Undercarriage Photo", "Insp Inside and Outside Doors Status",
  "Insp Inside and Outside Doors Estimate", "Insp Inside and Outside Doors Photo", "Insp Right Side Status", "Insp Right Side Estimate",
  "Insp Right Side Photo", "Insp Left Side Status", "Insp Left Side Estimate", "Insp Left Side Photo",
  "Insp Front Wall Status", "Insp Front Wall Estimate", "Insp Front Wall Photo", "Insp Ceiling/Roof Status",
  "Insp Ceiling/Roof Estimate", "Insp Ceiling/Roof Photo", "Insp Floor (Inside) Status", "Insp Floor (Inside) Estimate",
  "Insp Floor (Inside) Photo", "Insp Contamination Status", "Insp Contamination Estimate", "Insp Contamination Photo",
  "Insp Curtain Status", "Insp Curtain Estimate", "Insp Curtain Photo", "Insp Tube Light Status",
  "Insp Tube Light Estimate", "Insp Tube Light Photo", "Insp Mantrap Status", "Insp Mantrap Estimate",
  "Insp Mantrap Photo", "Insp Outside/Undercarriage Remark", "Insp Inside and Outside Doors Remark", "Insp Right Side Remark",
  "Insp Left Side Remark", "Insp Front Wall Remark", "Insp Ceiling/Roof Remark", "Insp Floor (Inside) Remark",
  "Insp Contamination Remark", "Insp Curtain Remark", "Insp Tube Light Remark", "Insp Mantrap Remark",
  "Machine Compressor Status", "Machine Compressor Estimate", "Machine Compressor Photo", "Machine Compressor Remark",
  "Machine Condenser Coil Status", "Machine Condenser Coil Estimate", "Machine Condenser Coil Photo", "Machine Condenser Coil Remark",
  "Machine Evaporator Coil Status", "Machine Evaporator Coil Estimate", "Machine Evaporator Coil Photo", "Machine Evaporator Coil Remark",
  "Machine Condenser Fan Status", "Machine Condenser Fan Estimate", "Machine Condenser Fan Photo", "Machine Condenser Fan Remark",
  "Machine Evaporator Fan Status", "Machine Evaporator Fan Estimate", "Machine Evaporator Fan Photo", "Machine Evaporator Fan Remark",
  "Machine Controller / Microprocessor Status", "Machine Controller / Microprocessor Estimate", "Machine Controller / Microprocessor Photo", "Machine Controller / Microprocessor Remark",
  "Machine Power Cable & Plug Status", "Machine Power Cable & Plug Estimate", "Machine Power Cable & Plug Photo", "Machine Power Cable & Plug Remark",
  "Machine Refrigerant Gas Charge Status", "Machine Refrigerant Gas Charge Estimate", "Machine Refrigerant Gas Charge Photo", "Machine Refrigerant Gas Charge Remark",
  "Machine Temperature Sensors / Probes Status", "Machine Temperature Sensors / Probes Estimate", "Machine Temperature Sensors / Probes Photo", "Machine Temperature Sensors / Probes Remark",
  "Unused (reserved)", "Marked (legacy, unused)", "Machine Defrost System Status", "Machine Defrost System Estimate",
  "Machine Defrost System Photo", "Machine Defrost System Remark", "Insp Gasket Door Status", "Insp Gasket Door Estimate",
  "Insp Gasket Door Photo", "Insp Gasket Door Remark", "Machine Cable 4 Core 4mm 18Mtr Status", "Machine Cable 4 Core 4mm 18Mtr Estimate",
  "Machine Cable 4 Core 4mm 18Mtr Photo", "Machine Cable 4 Core 4mm 18Mtr Remark", "Machine Motor Condition Status", "Machine Motor Condition Estimate",
  "Machine Motor Condition Photo", "Machine Motor Condition Remark", "Machine Contractor Status", "Machine Contractor Estimate",
  "Machine Contractor Photo", "Machine Contractor Remark", "Machine ISO Plug Status", "Machine ISO Plug Estimate",
  "Machine ISO Plug Photo", "Machine ISO Plug Remark", "Machine Technician Hours", "Machine Technician Cost",
  "Cabin Fan Available", "Cabin LED Available", "Cabin 5 Amp Switch Available", "Cabin Window Available",
  "Cabin 15A Switch Available", "Cabin Bulkhead Available", "Cabin AC Point Available", "Cabin MCB Available",
  "Cabin Manager Table Available", "Cabin Table Available", "Cabin Overhead Storage Available", "Cabin Chair Available",
  "Cabin Partition Available", "Insp Gasket Door Remark", "Machine Cable 4 Core 4mm 18Mtr Status", "Machine Cable 4 Core 4mm 18Mtr Estimate",
  "Machine Cable 4 Core 4mm 18Mtr Photo", "Machine Cable 4 Core 4mm 18Mtr Remark", "Machine Motor Condition Status", "Machine Motor Condition Estimate",
  "Machine Motor Condition Photo", "Machine Motor Condition Remark", "Machine Contractor Status", "Machine Contractor Estimate",
  "Machine Contractor Photo", "Machine Contractor Remark", "Machine ISO Plug Status", "Machine ISO Plug Estimate",
  "Machine ISO Plug Photo", "Machine ISO Plug Remark", "Machine Technician Hours", "Machine Technician Cost",
  "Cabin Fan Available", "Cabin LED Available", "Cabin 5 Amp Switch Available", "Cabin Window Available",
  "Cabin 15A Switch Available", "Cabin Bulkhead Available", "Cabin AC Point Available", "Cabin MCB Available",
  "Cabin Manager Table Available", "Cabin Table Available", "Cabin Overhead Storage Available", "Cabin Chair Available",
  "Cabin Partition Available", "Source DO No",
  "Move To Stage Reason", "Move To Stage New Client Name", "Move To Stage Remarks", "Move To Stage By", "Move To Stage Timestamp",
  "Move To Stage Comment / Type", "Move To Stage Date", "Move To Stage Jump Target", "Move To Stage Client Scope",
  "Move To Stage Arrival Date",
];
