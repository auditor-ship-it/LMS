import * as XLSX from 'xlsx';
import { jsPDF } from 'jspdf';
import {
  buildIdentityRows, buildProgressRows, buildFilledStages, lookupFileStamp,
  checklistHead, buildEstimateTotals, buildEstimateRows, ESTIMATE_HEAD, money, CABIN_HEAD,
  buildInvoices, INVOICE_HEAD, buildHistoryRows, HISTORY_HEAD, buildMovements, MOVEMENT_HEAD, slaText
} from './lookupModel.js';
import {
  createReport, drawTitle, drawBrand, drawHeaderBand, drawStageHeader, drawFieldGrid, drawDataTable,
  drawSubHeading, drawTotalRow, drawEmptyStageBody, stampFooters
} from './pdfLayout.js';
import { BRAND } from './brand.js';

/**
 * Download for a Container Lookup result — the same content the card shows on
 * screen (identity, off-lease progress, filled stage data), as .xlsx or .pdf.
 * Everything comes from the lookup response already in hand, so neither
 * export re-hits the API.
 *
 * The PDF reproduces the original "Off-Lease Container Report" printout: a
 * header card with the stage pill, a 3-across identity grid, then one
 * headed grid per completed stage. Drawn with pdfLayout.js primitives rather
 * than printed from the DOM, so it downloads straight to a file instead of
 * going through the browser's print dialog (and carries no print headers,
 * page URL, or clipped card borders).
 */

const PROGRESS_HEAD = ['Stage', 'Name', 'Status', 'Completed On', 'By'];

function summaryLine(result) {
  return [result.clientName, result.clientCode].filter(Boolean).join(' · ');
}

/* ------------------------------------------------------------------ Excel */

export function exportLookupToExcel(result) {
  const identity = buildIdentityRows(result);
  const progress = buildProgressRows(result);
  const filled = buildFilledStages(result);

  const summaryAoa = [
    ['Off-Lease Container Report'],
    ['Container', result.container || ''],
    ['Client', summaryLine(result)],
    ['Current Stage', result.currentStage || ''],
    [],
    ['Details'],
    ...identity.map(([label, value]) => [label, value == null ? '' : String(value)])
  ];

  if (progress.length) {
    summaryAoa.push([], ['Off-Lease Progress'], PROGRESS_HEAD);
    progress.forEach((r) => summaryAoa.push([r.stage, r.name, r.status, r.on, r.by]));
  }

  // The same Stage 1..9 history the screen leads with, so the download is not
  // a narrower view of the record than the page it came from.
  const history = buildHistoryRows(result);
  if (history.length) {
    summaryAoa.push([], ['Container History — Stage 1 to Stage 9'], HISTORY_HEAD);
    history.forEach((r) => summaryAoa.push([r.stage, r.name, r.status, r.on, r.by, slaText(r.sla), r.detail]));
  }

  const summarySheet = XLSX.utils.aoa_to_sheet(summaryAoa);
  summarySheet['!cols'] = [{ wch: 24 }, { wch: 30 }, { wch: 14 }, { wch: 20 }, { wch: 30 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, summarySheet, 'Summary');

  // One flat sheet rather than a sheet per stage — keeps it filterable and
  // sidesteps Excel's 31-char sheet-name limit however stages get renamed.
  if (filled.length) {
    const stageAoa = [['Stage', 'Stage Name', 'Completed On', 'By', 'Field', 'Value']];
    filled.forEach((s) => {
      if (!s.fields.length) {
        stageAoa.push([s.stage, s.label, s.timestamp, s.user, '', '']);
        return;
      }
      s.fields.forEach(([label, value]) => {
        stageAoa.push([s.stage, s.label, s.timestamp, s.user, label, value]);
      });
    });
    const stageSheet = XLSX.utils.aoa_to_sheet(stageAoa);
    stageSheet['!cols'] = [{ wch: 8 }, { wch: 24 }, { wch: 20 }, { wch: 30 }, { wch: 26 }, { wch: 40 }];
    XLSX.utils.book_append_sheet(wb, stageSheet, 'Stage Data');
  }

  // Each checklist gets its own sheet — they are tables, not field/value
  // pairs, and belong in one filterable block each.
  const COLS = [{ wch: 5 }, { wch: 30 }, { wch: 14 }, { wch: 14 }, { wch: 46 }, { wch: 40 }];
  filled.flatMap((s) => s.checklists).forEach((c) => {
    const sheet = XLSX.utils.aoa_to_sheet([checklistHead(c.pointLabel), ...c.rows]);
    sheet['!cols'] = COLS;
    XLSX.utils.book_append_sheet(wb, sheet, c.title.slice(0, 31));
  });

  // Stage 9 movements get their own sheet — a journal, one row per movement.
  const movements = buildMovements(result);
  if (movements) {
    const sheet = XLSX.utils.aoa_to_sheet([MOVEMENT_HEAD, ...movements.rows]);
    sheet['!cols'] = [{ wch: 16 }, { wch: 14 }, { wch: 22 }, { wch: 14 }, { wch: 40 }, { wch: 30 }];
    XLSX.utils.book_append_sheet(wb, sheet, 'Stage 9 Movements');
  }

  // Invoices — same API response as the PDF and the Stage 1 panel.
  const invoices = buildInvoices(result);
  if (invoices) {
    const sheet = XLSX.utils.aoa_to_sheet([
      INVOICE_HEAD,
      ...invoices.rows,
      [],
      ['', '', 'Grand Total', invoices.grandTotal, '', '']
    ]);
    sheet['!cols'] = [{ wch: 22 }, { wch: 46 }, { wch: 12 }, { wch: 16 }, { wch: 8 }, { wch: 44 }];
    XLSX.utils.book_append_sheet(wb, sheet, 'Invoices');
  }

  // Same estimate summary the PDF closes with, so the total can be checked
  // against the line items in a spreadsheet.
  const totals = buildEstimateTotals(result);
  if (totals) {
    const aoa = [
      ESTIMATE_HEAD,
      ...buildEstimateRows(totals),
      [],
      ['', '', '', 'Total Estimate', money(totals.total)]
    ];
    const sheet = XLSX.utils.aoa_to_sheet(aoa);
    sheet['!cols'] = [{ wch: 16 }, { wch: 34 }, { wch: 16 }, { wch: 46 }, { wch: 14 }];
    XLSX.utils.book_append_sheet(wb, sheet, 'Estimate Summary');
  }

  XLSX.writeFile(wb, `${lookupFileStamp(result)}.xlsx`);
}

/* -------------------------------------------------------------------- PDF */

function formatStamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}, ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const CARD_GAP = 3.5;

export function exportLookupToPdf(result) {
  const identity = buildIdentityRows(result);
  const filled = buildFilledStages(result);

  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const rpt = createReport(doc);
  const sub = summaryLine(result);

  const titleBottom = drawTitle(doc, 18, `Off-Lease Container Report — ${result.container || ''}`, sub);
  const brandBottom = drawBrand(doc, 18, BRAND);
  rpt.y = Math.max(titleBottom, brandBottom) + CARD_GAP + 1.5;

  // Identity card — header band and the detail grid share one card, as in the
  // reference report.
  rpt.openCard();
  drawHeaderBand(rpt, doc, { container: result.container, subtitle: sub, pill: result.currentStage });
  drawFieldGrid(rpt, doc, identity.map(([label, value], i) => ({
    label,
    value,
    accent: i === 0 // Order No is the report's one highlighted value
  })));
  rpt.closeCard();

  /* Container history — the whole Stage 1..9 record in one table, right after
     the identity card, matching what the screen leads with. */
  const history = buildHistoryRows(result);
  if (history.length) {
    rpt.y += CARD_GAP;
    rpt.openCard();
    drawSubHeading(rpt, doc, 'Container History — Stage 1 to Stage 9');
    drawDataTable(
      rpt, doc, HISTORY_HEAD,
      history.map((r) => [r.stage, r.name, r.status, r.on, r.by, slaText(r.sla) || '—', r.detail || '—']),
      [16, 32, 20, 22, 30, 34, 28], { compact: true }
    );
    rpt.closeCard();
  }

  const movements = buildMovements(result);
  if (movements) {
    rpt.y += CARD_GAP;
    rpt.openCard();
    drawSubHeading(rpt, doc, `Stage 9 — Container Movements (${movements.count})`);
    drawDataTable(rpt, doc, MOVEMENT_HEAD, movements.rows, [24, 22, 30, 22, 46, 30], { compact: true });
    rpt.closeCard();
  }

  /* Repair estimate summary sits directly ABOVE the Stage 3 inspection — the
     reader wants the chargeable total before the point-by-point detail that
     justifies it, but after the earlier stages' history. Drawn compact so it
     reads as a summary rather than competing with the checklists below.
     Anchored to Stage 3 rather than to a fixed position, so it stays put
     however many earlier stages a record happens to have completed. */
  const totals = buildEstimateTotals(result);
  const drawEstimateSummary = () => {
    rpt.y += CARD_GAP;
    rpt.openCard();
    drawSubHeading(rpt, doc, 'Repair Estimate Summary');
    drawDataTable(rpt, doc, ESTIMATE_HEAD, buildEstimateRows(totals), [18, 38, 22, 44, 22], { compact: true });
    drawTotalRow(rpt, doc, 'Total Estimate', money(totals.total), { compact: true });
    rpt.closeCard();
  };
  let summaryDrawn = false;

  // One card per completed stage. Pending stages are omitted — where the
  // container has got to is already on the pill above.
  filled.forEach((s) => {
    if (totals && !summaryDrawn && s.internalStage === 3) { drawEstimateSummary(); summaryDrawn = true; }
    rpt.y += CARD_GAP;
    rpt.openCard();
    drawStageHeader(rpt, doc, {
      stage: s.retired ? null : s.stage,
      label: s.retired ? `${s.label} (retired)` : s.label,
      status: 'Completed',
      meta: [s.timestamp, s.user].filter(Boolean).join(' · ')
    });
    if (s.fields.length) {
      drawFieldGrid(rpt, doc, s.fields.map(([label, value]) => ({ label, value })));
    }
    // Stage 3's checklists — column tables, not label/value cells.
    s.checklists.forEach((c) => {
      drawSubHeading(rpt, doc, c.title);
      // The "#" column must fit two digits (points 10 and 11) plus cell padding.
      drawDataTable(rpt, doc, checklistHead(c.pointLabel), c.rows, [10, 43, 24, 22, 22, 45]);
    });
    if (s.cabin.length) {
      drawSubHeading(rpt, doc, 'Site Cabin Fittings');
      drawDataTable(rpt, doc, CABIN_HEAD, s.cabin, [10, 60, 20, 24, 20]);
    }
    if (!s.fields.length && !s.checklists.length && !s.cabin.length) {
      drawEmptyStageBody(rpt, doc, 'No fields recorded for this stage.');
    }
    rpt.closeCard();
  });

  // Stage 3 not completed yet (so not in `filled`) — the estimate still
  // matters, so it goes after whatever stages did render rather than vanishing.
  if (totals && !summaryDrawn) drawEstimateSummary();


  /* Invoices — the exact Accounts & Collection API response, one row per
     invoice in the order returned. No month filter, no grouping, no sheet
     data. Same source as the Stage 1 panel, so they cannot disagree. */
  const invoices = buildInvoices(result);
  if (invoices) {
    rpt.y += CARD_GAP;
    rpt.openCard();
    drawSubHeading(rpt, doc, `Invoices${invoices.party ? ` — ${invoices.party}` : ''}`);
    drawDataTable(rpt, doc, INVOICE_HEAD, invoices.rows, [24, 32, 15, 18, 11, 42], { compact: true });
    drawTotalRow(rpt, doc, `Grand Total (${invoices.count} invoice${invoices.count === 1 ? '' : 's'})`, invoices.grandTotal, { compact: true });
    rpt.closeCard();
  }

  stampFooters(doc, formatStamp(new Date()), BRAND.name);
  doc.save(`${lookupFileStamp(result)}.pdf`);
}
