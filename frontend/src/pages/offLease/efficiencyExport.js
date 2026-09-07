/**
 * Off-Lease Efficiency — PDF export. Same jsPDF + jspdf-autotable pattern
 * DeployedSummaryPage.jsx and ContainerDetailModal.jsx already use for a
 * multi-section dashboard export (as opposed to lookupExport.js's
 * hand-drawn single-record card layout — this page is an aggregate report,
 * not one container's detail, so the simpler table-first approach fits).
 *
 * Landscape, same reasoning as DeployedSummaryPage's own sectioned export:
 * the stage-wise and container tables both have enough columns that
 * landscape keeps every one readable without shrinking the font past use.
 */
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { BRAND } from './brand.js';

const NAVY = [5, 35, 121];

function formatStamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}, ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fmtMin(min) {
  if (min == null) return '—';
  const total = Math.round(min);
  if (total < 60) return `${total}m`;
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const mins = total % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}
const fmtPct = (p) => (p == null ? '—' : `${p}%`);

/** `data` is exactly the GET /offlease/efficiency payload the page itself
 *  renders — { overall, stages, containers, dataQuality } — so the PDF can
 *  never show a number the on-screen dashboard didn't. */
export function exportEfficiencyToPdf(data) {
  const { overall, stages, containers, dataQuality } = data;
  const doc = new jsPDF({ orientation: 'landscape' });
  const pageWidth = doc.internal.pageSize.getWidth();

  doc.setFontSize(15);
  doc.setTextColor(...NAVY);
  doc.text('Off-Lease Efficiency Report', 14, 16);
  doc.setFontSize(9);
  doc.setTextColor(110, 110, 110);
  doc.text(`${BRAND.name} — generated ${formatStamp(new Date())}`, 14, 22);

  // ---- Overall summary ----
  doc.setFontSize(11);
  doc.setTextColor(0, 0, 0);
  doc.text('Overall', 14, 32);
  autoTable(doc, {
    startY: 35,
    theme: 'plain',
    styles: { fontSize: 9, cellPadding: 1.2 },
    body: [
      ['Cumulative Efficiency', fmtPct(overall.cumulativeEfficiencyPercentage), 'On-Time Rate', fmtPct(overall.onTimeRate)],
      ['Total Containers', String(overall.totalCases), 'Needs Data Review', String(overall.invalidDataCases)],
      ['Completed', String(overall.completedCases), 'In Progress', String(overall.inProgressCases)],
      ['Total Target Time', fmtMin(overall.totalTargetMinutes), 'Total Actual Time', fmtMin(overall.totalActualMinutes)]
    ],
    columnStyles: { 0: { fontStyle: 'bold', cellWidth: 55 }, 2: { fontStyle: 'bold', cellWidth: 55 } },
    margin: { left: 14 }
  });

  // ---- Stage-wise ----
  let y = doc.lastAutoTable.finalY + 10;
  doc.setFontSize(11);
  doc.text('Stage-Wise Efficiency', 14, y);
  autoTable(doc, {
    startY: y + 3,
    head: [['Stage', 'Owner', 'Target', 'Avg Actual', 'Efficiency', 'Below Target', 'Completed', 'Pending', 'Hold', 'Rework', 'N/A', 'Missing']],
    body: stages.map((s) => [
      s.stageName, s.owner, fmtMin(s.targetDurationMinutes), fmtMin(s.avgActualDurationMinutes),
      fmtPct(s.efficiencyPercentage), s.totalSeen ? `${s.belowTargetCount} of ${s.totalSeen}` : '—',
      String(s.completedCount), String(s.pendingCount), String(s.onHoldCount), String(s.reworkCount),
      String(s.notApplicableCount), String(s.missingDataCount)
    ]),
    styles: { fontSize: 8 },
    headStyles: { fillColor: NAVY },
    margin: { left: 14, right: 14 }
  });

  // ---- Data quality ----
  y = doc.lastAutoTable.finalY + 10;
  if (y > 160) { doc.addPage(); y = 18; }
  doc.setFontSize(11);
  doc.text('Data Quality', 14, y);
  autoTable(doc, {
    startY: y + 3,
    theme: 'plain',
    styles: { fontSize: 9, cellPadding: 1.2 },
    body: [
      ['Valid', String(dataQuality.validEfficiencyRecords), 'Needs Manual Review', String(dataQuality.recordsRequiringManualReview)],
      ['Missing Timestamps', String(dataQuality.missingTimestampRecords), 'Invalid Timestamps', String(dataQuality.invalidTimestampRecords)],
      ['Not Applicable', String(dataQuality.notApplicableRecords), 'On Hold', String(dataQuality.holdRecords)],
      ['Rework Detected', String(dataQuality.reworkRecords), '', '']
    ],
    columnStyles: { 0: { fontStyle: 'bold', cellWidth: 55 }, 2: { fontStyle: 'bold', cellWidth: 55 } },
    margin: { left: 14 }
  });
  y = doc.lastAutoTable.finalY + 6;
  if (dataQuality.knownLimitations?.length) {
    doc.setFontSize(9);
    doc.setTextColor(110, 110, 110);
    for (const line of dataQuality.knownLimitations) {
      const wrapped = doc.splitTextToSize(`• ${line}`, pageWidth - 28);
      if (y + wrapped.length * 4 > 195) { doc.addPage(); y = 18; }
      doc.text(wrapped, 14, y);
      y += wrapped.length * 4 + 2;
    }
    doc.setTextColor(0, 0, 0);
  }

  // ---- Containers, worst efficiency first (same sort as the on-screen table) ----
  doc.addPage();
  doc.setFontSize(11);
  doc.text(`Containers (${containers.length}) — Lowest Efficiency First`, 14, 16);
  const sorted = [...containers].sort((a, b) => {
    const ea = a.cumulative?.cumulativeEfficiencyPercentage, eb = b.cumulative?.cumulativeEfficiencyPercentage;
    if (ea == null && eb == null) return 0;
    if (ea == null) return 1;
    if (eb == null) return -1;
    return ea - eb;
  });
  autoTable(doc, {
    startY: 20,
    head: [['#', 'Container', 'Client', 'Current Stage', 'Efficiency', 'Target', 'Actual', 'Rework']],
    body: sorted.map((c, i) => [
      String(i + 1), c.containerNo, c.clientName, c.currentStage,
      fmtPct(c.cumulative?.cumulativeEfficiencyPercentage), fmtMin(c.cumulative?.totalTargetMinutes),
      fmtMin(c.cumulative?.totalActualMinutes), c.hadRework ? 'Yes' : ''
    ]),
    styles: { fontSize: 8 },
    headStyles: { fillColor: NAVY },
    margin: { left: 14, right: 14 }
  });

  const pageCount = doc.internal.getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    doc.setFontSize(8);
    doc.setTextColor(150, 150, 150);
    doc.text(`${BRAND.name} — Off-Lease Efficiency Report — Page ${p} of ${pageCount}`, 14, doc.internal.pageSize.getHeight() - 8);
  }

  const stamp = new Date().toISOString().slice(0, 10);
  doc.save(`Off-Lease-Efficiency-${stamp}.pdf`);
}
