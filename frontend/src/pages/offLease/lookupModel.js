/**
 * Shared, render-free shape of a container-lookup result — the single source
 * of truth for *which* fields the lookup shows and in what order. Both the
 * on-screen card (LookupResult.jsx) and the Excel/PDF download
 * (lookupExport.js) read from here, so a field added in one place can't
 * silently go missing from the other.
 *
 * `rate` is deliberately absent, matching the system-wide convention that
 * pricing is hidden from every grid/detail view (utils/isRateOrAmountHeader.js)
 * — the API response includes it, and it stays out of the download too.
 */

import { formatActionTimestamp } from '../../utils/formatDateTime.js';

export const APPROVAL_LABEL = { approved: 'Approved', rejected: 'Rejected' };

/** Raw sheet cell -> plain text. The screen renders bare URLs as a 📎 link
 *  (CellValue.jsx); a downloaded file has nowhere to click, so it keeps the
 *  full URL instead. */
export function cellText(v) {
  return v == null ? '' : String(v);
}

/** Identity fields, in display order — [label, value] pairs. */
export function buildIdentityRows(result) {
  const {
    orderNos, leaseId, clientCode, clientName, size, type, location,
    deployedDate, validUpto, inOffLease, approvalStatus, approvalDate, approvalUser
  } = result;

  const rows = [
    ['Order No', orderNos],
    ['Lease ID', leaseId],
    ['Client Code', clientCode],
    ['Client Name', clientName],
    ['Size', size],
    ['Type', type],
    ['Location', location],
    ['Deployed Date', deployedDate],
    ['Valid Upto', validUpto]
  ];

  if (inOffLease && approvalStatus) {
    rows.push(['Approval Status', APPROVAL_LABEL[String(approvalStatus).toLowerCase()] || approvalStatus]);
    if (approvalDate) rows.push(['Approved / Rejected On', formatActionTimestamp(approvalDate)]);
    if (approvalUser) rows.push(['Approved By', approvalUser]);
  }

  return rows;
}

/**
 * The 8 stage cards plus the Intimation Approval gate, flattened to table
 * rows. Mirrors the board's ordering exactly: the gate sits between Stage 1
 * and Stage 2, and statuses stay the same Completed/Pending wording the cards
 * show (which stage is "current" is carried by result.currentStage, the same
 * way the header pill carries it on screen).
 */
export function buildProgressRows(result) {
  const { stages = [], approvalStatus, approvalDate, approvalUser } = result;
  const approvalLower = String(approvalStatus || '').trim().toLowerCase();
  const decided = approvalLower && approvalLower !== 'pending';

  const gateRow = {
    stage: 'Gate',
    name: 'Intimation Approval',
    status: APPROVAL_LABEL[approvalLower] || 'Pending',
    on: decided ? formatActionTimestamp(approvalDate) : '',
    by: decided ? cellText(approvalUser) : '',
    sla: result.approvalSla || null
  };

  return stages.flatMap((s, i) => {
    const row = {
      stage: s.displayStage ? `Stage ${s.displayStage}` : 'Retired',
      name: cellText(s.label),
      status: s.done ? 'Completed' : 'Pending',
      on: s.done ? formatActionTimestamp(s.timestamp) : '',
      by: s.done ? cellText(s.user) : '',
      sla: s.sla || null
    };
    return i === 0 ? [row, gateRow] : [row];
  });
}

/**
 * Stage 9 movements for this container, newest first, exactly as the movement
 * sheet holds them. Null when the container has never been moved, so the
 * section is omitted rather than printing an empty table.
 */
export const MOVEMENT_HEAD = ['Movement Type', 'Movement Date', 'Location', 'Lease ID', 'Remarks', 'Entered By'];

export function buildMovements(result) {
  const list = result.movements || [];
  if (!list.length) return null;
  return {
    count: list.length,
    rows: list.map((m) => [
      cellText(m.movementType) || '—',
      cellText(m.movementDate) || '—',
      cellText(m.location) || '—',
      cellText(m.leaseId) || '—',
      cellText(m.remarks) || '—',
      cellText(m.enteredBy) || '—'
    ])
  };
}

/**
 * THE single-screen history: every off-lease event for this container in one
 * ordered list — Stage 1, the Approval gate, the remaining pipeline stages,
 * then each Stage 9 movement.
 *
 * Stages 1-8 are states (a stage is Completed or Pending, once), whereas
 * Stage 9 is a journal (a container can be moved any number of times), so the
 * movements are appended as one row each rather than folded into a single
 * "Stage 9" row. They sit at the end because they are not gated by the
 * pipeline and can happen at any point in it — their own date column carries
 * when each actually occurred.
 */
export const HISTORY_HEAD = ['Stage', 'Event', 'Status', 'Date', 'By', 'SLA', 'Details'];

/** "2h 15m of 1h · 1h 15m late" — the budget, what was used, and by how much
 *  it slipped. An "SLA" column saying only "Delayed" would not say whether it
 *  slipped by a minute or a month. */
export function slaText(sla) {
  if (!sla) return '';
  const budget = sla.budgetMs >= 86400000
    ? `${Math.round(sla.budgetMs / 86400000)}d`
    : `${Math.round(sla.budgetMs / 3600000)}h`;
  const base = `${sla.elapsed} of ${budget}`;
  if (sla.delayed) return `${base} · ${sla.overdueBy} late`;
  return sla.running ? `${base} · running` : `${base} · on time`;
}

export function buildHistoryRows(result) {
  /* Retired stages are left out of the history: they are not part of the
     workflow, so a row for one sits in the sequence claiming a position it no
     longer has. Their captured data is still preserved and still rendered
     below in Filled Stage Data and in the PDF — only this summary drops them. */
  const stageRows = buildProgressRows(result)
    .filter((r) => r.stage !== 'Retired')
    .map((r) => ({ ...r, detail: '' }));

  /* Stage 9 movements are a journal, not a timed step — no SLA applies. */
  const movementRows = (result.movements || []).map((m) => ({
    stage: 'Stage 9',
    name: `Movement — ${cellText(m.movementType) || 'Unspecified'}`,
    status: 'Logged',
    on: formatActionTimestamp(m.movementDate) || formatActionTimestamp(m.timestamp),
    by: cellText(m.enteredBy),
    detail: [cellText(m.location), cellText(m.remarks)].filter(Boolean).join(' · ')
  }));

  return [...stageRows, ...movementRows];
}

/** Header row for a Stage 3 checklist table in the exports. */
export const checklistHead = (pointLabel) => ['#', pointLabel, 'Good / Damage', 'Estimate', 'Photo', 'Remarks'];

/** The Stage 3 checklists, in display order — `key` is the field the detail
 *  endpoint returns them under. */
export const CHECKLISTS = [
  { key: 'inspection', title: 'Container Inspection Checklist', pointLabel: 'Instruction Point' },
  { key: 'machine', title: 'Machine Check', pointLabel: 'Machine Point' }
];

/** One checklist's points as flat table rows, in board order. */
export function buildChecklistRows(points) {
  return (points || []).map((p) => [
    String(p.n),
    cellText(p.item),
    cellText(p.status) || '—',
    money(p.estimate) || '—', // grouped, never date-formatted
    cellText(p.photo) || '—',
    cellText(p.remark) || '—'
  ]);
}

/** Cabin fittings as table rows: Sr / Item / Qty / Available / Shortfall. */
export const CABIN_HEAD = ['#', 'Item', 'Qty', 'Available', 'Short'];
export function buildCabinRows(points) {
  return (points || []).map((p) => {
    const qty = String(p.qty ?? '').trim();
    const avail = String(p.available ?? '').trim();
    /* Shortfall only makes sense when BOTH sides are numbers. A column can
       hold stray non-numeric text (e.g. a legacy "Marked" flag left behind by
       a column edit), which used to render as "NaN". */
    const qtyNum = Number(qty);
    const availNum = Number(avail);
    const comparable = qty !== '' && avail !== '' && Number.isFinite(qtyNum) && Number.isFinite(availNum);
    const short = comparable ? qtyNum - availNum : null;
    return [
      String(p.n),
      cellText(p.item),
      qty === '' ? '—' : qty,
      avail === '' ? '—' : avail,
      short === null || short <= 0 ? '—' : String(short)
    ];
  });
}

/** Completed stages with the fields captured for each — the "Filled Stage
 *  Data" section, as plain [label, value] pairs, plus Stage 3's inspection
 *  checklist as its own table (the detail endpoint returns it structured
 *  rather than as 44 loose fields). */
export function buildFilledStages(result) {
  return (result.stages || [])
    .filter((s) => s.done)
    .map((s) => ({
      stage: s.displayStage ?? s.stage,
      // The internal number survives the display renumbering, so callers can
      // anchor to a specific stage (the estimate summary sits above Stage 3).
      internalStage: s.stage,
      retired: !s.displayStage,
      label: cellText(s.label),
      timestamp: formatActionTimestamp(s.timestamp),
      user: cellText(s.user),
      fields: (s.fields || []).map((f) => [cellText(f.label), cellText(f.value)]),
      // [{title, pointLabel, rows}] for whichever checklists this stage has.
      checklists: CHECKLISTS
        .filter((c) => (s[c.key] || []).length)
        .map((c) => ({ ...c, rows: buildChecklistRows(s[c.key]) })),
      cabin: buildCabinRows(s.cabin)
    }));
}

/** Indian-grouped money, e.g. 1234567 -> "12,34,567". Blank stays blank. */
export function money(v) {
  const n = Number(String(v ?? '').replace(/,/g, '').trim());
  if (!Number.isFinite(n) || String(v ?? '').trim() === '') return '';
  return n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

function amountOf(v) {
  const n = Number(String(v ?? '').replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : 0;
}

/**
 * Repair cost across the whole Stage 3 inspection: every point's estimate,
 * plus technician labour. Returns the individual lines so the invoice can show
 * what makes up the total rather than just asserting it.
 */
export function buildEstimateTotals(result) {
  const stage3 = (result.stages || []).find((s) => s.stage === 3);
  if (!stage3) return null;

  const lines = [];
  for (const [key, section] of [['inspection', 'Inspection'], ['machine', 'Machine Check']]) {
    for (const p of stage3[key] || []) {
      const amount = amountOf(p.estimate);
      if (amount > 0) {
        lines.push({ section, item: p.item, status: cellText(p.status), remark: cellText(p.remark), amount });
      }
    }
  }

  const tech = stage3.technician;
  const techAmount = tech ? amountOf(tech.cost) : 0;
  if (tech && (techAmount > 0 || amountOf(tech.hours) > 0)) {
    lines.push({
      section: 'Labour',
      item: `Technician (${cellText(tech.hours)} hr @ ${money(tech.rate)}/hr)`,
      status: '',
      remark: '',
      amount: techAmount
    });
  }

  if (!lines.length) return null;
  return { lines, total: lines.reduce((sum, l) => sum + l.amount, 0) };
}

/**
 * Billing, fetched from the Billing Sales sheet by container number and shown
 * on the report automatically. Null when the container has no billing rows, so
 * the section is omitted rather than printing an empty table.
 */
export const BILLING_HEAD = ['#', 'Container No', 'Client Name', 'Invoice No', 'Invoice Attachment', 'Amount'];

/**
 * Invoices for the report, straight from the Accounts & Collection API
 * response (`result.outstanding`). Every invoice it returns is rendered, in
 * the order returned — no month filter, no grouping, no deduplication, no
 * truncation. The Google Sheet is never consulted here.
 */
export const INVOICE_HEAD = ['Invoice No.', 'Container No(s).', 'Month', 'Total Amount', 'Age', 'Invoice'];

/**
 * Invoice number -> its attachment link, from the Billing Sales sheet.
 *
 * FALLBACK ONLY. The primary source is the Accounts & Collection ledger's
 * per-invoice `invoiceCopyUrl` (see accountsApi.service.js), which has a file
 * for every open invoice. This sheet join covers the reverse case: Billing
 * Sales holds a row the ledger does not.
 */
const normInvoiceNo = (v) => cellText(v).toUpperCase().replace(/[^A-Z0-9]/g, '');

function attachmentsByInvoice(result) {
  const map = new Map();
  /* Keyed on the invoice number, matched on alphanumerics only so separator
     and case differences between the two systems do not miss. */
  for (const [no, link] of Object.entries(result.invoiceAttachments || {})) {
    if (no && link) map.set(normInvoiceNo(no), link);
  }
  // Billing records are a secondary source — they only match when the
  // container AND client agree, which is often not the case.
  for (const r of result.billing?.records || []) {
    const no = normInvoiceNo(r.invoiceNo);
    const link = cellText(r.attachment).trim();
    if (no && link && !map.has(no)) map.set(no, link);
  }
  return map;
}

export function buildInvoices(result) {
  const o = result.outstanding;
  const list = o?.invoiceTotals || [];
  if (!list.length) return null;
  const files = attachmentsByInvoice(result);
  return {
    count: list.length,
    party: cellText(o.matchedParty),
    rows: list.map((i) => [
      cellText(i.invoiceNo) || '—',
      (i.containers || []).join(', ') || '—',
      cellText(i.period) || '—',
      money(i.amount) || '—',
      i.overdueDays ? `${i.overdueDays}d` : '—',
      /* The invoice's OWN document, from the Accounts & Collection ledger
         (`invoiceCopyUrl`) — one distinct file per invoice number. The Billing
         Sales join stays as a fallback for invoices that sheet happens to
         carry and the ledger does not. Empty string, never a neighbouring
         invoice's file: the cell renders as "No file" instead. */
      cellText(i.invoiceUrl) || files.get(normInvoiceNo(i.invoiceNo)) || ''
    ]),
    grandTotal: money(o.grandTotal),
    grandOutstanding: money(o.grandOutstanding)
  };
}

export function buildBilling(result) {
  const b = result.billing;
  if (!b || !(b.records || []).length) return null;

  /* Client name comes from the Off-Lease record, not from each Billing Sales
     row. The same container can carry different client names across invoices
     in that sheet (data drift from earlier leases); the report should name the
     client this off-lease actually belongs to. */
  const client = cellText(b.clientName) || cellText(result.clientName);

  return {
    count: b.count,
    container: cellText(b.container) || cellText(result.container),
    clientName: client,
    total: money(b.totalBilling),
    rows: b.records.map((r, i) => [
      String(i + 1),
      cellText(r.container) || '—',
      client || '—',
      cellText(r.invoiceNo) || '—',
      cellText(r.attachment) || '—', // a URL renders as a link in the PDF
      money(r.amount) || '—'
    ])
  };
}

/** Header + rows for the estimate summary table, shared by the PDF and Excel. */
export const ESTIMATE_HEAD = ['Section', 'Item', 'Condition', 'Remarks', 'Amount'];
export function buildEstimateRows(totals) {
  return totals.lines.map((l) => [l.section, l.item, l.status || '—', l.remark || '—', money(l.amount)]);
}


/** `Container-BMOU9729398` — base name shared by the .xlsx and .pdf. */
export function lookupFileStamp(result) {
  const safe = String(result.container || 'container').replace(/[^A-Za-z0-9._-]+/g, '-');
  return `Container-${safe}`;
}
