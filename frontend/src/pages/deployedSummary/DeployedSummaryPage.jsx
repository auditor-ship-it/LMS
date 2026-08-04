import { useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { PageHeader, Card, Button, Select, StatCard, DataGrid, ActionMenu, LoadingState, ErrorState, EmptyState, renderCellValue } from '../../components/ui/index.js';
import { useAsync } from '../../hooks/useAsync.js';
import { apiErrorMessage } from '../../shared/auth/index.js';
import { fetchDeployedSummary, fetchDeployedDetail } from '../../services/deployedSummary.service.js';
import styles from './DeployedSummaryPage.module.css';

const GROUPS = [
  { key: 'opening', label: 'Opening Deployed' },
  { key: 'addition', label: 'Addition' },
  { key: 'deletion', label: 'Deletion' },
  { key: 'net', label: 'Net Movement' },
  { key: 'closing', label: 'Closing Deployed' }
];

const DETAIL_HEADERS = ['Container', 'Order No', 'Client Code', 'Client Name', 'Size', 'Type', 'Location', 'Deployed Date', 'Valid Upto', 'Movement'];

/**
 * Reads one summary cell out of a Deployed Summary row — same shape
 * GET /dashboard/deployed-summary returns (dashboard.service.js): plain
 * numbers per category/type, per-size breakdowns under row._sz.
 */
function getVal(row, category, typeVal, sizeVal, types) {
  if (!row || !row[category]) return 0;
  if (!typeVal && !sizeVal) return row[category].total || 0;
  if (typeVal && !sizeVal) return row[category][typeVal] || 0;
  if (typeVal && sizeVal) {
    return (row._sz && row._sz[category] && row._sz[category][typeVal] && row._sz[category][typeVal][sizeVal]) || 0;
  }
  let total = 0;
  for (const t of types || []) {
    total += (row._sz && row._sz[category] && row._sz[category][t] && row._sz[category][t][sizeVal]) || 0;
  }
  return total;
}

/**
 * Deployed Summary — month-wise deployed-container movement (opening /
 * addition / deletion / net / closing), with a type/size filter and a
 * container-level drill-down per cell. Backed by GET /dashboard/deployed-
 * summary and /dashboard/deployed-detail — the same Deployed-sheet-derived
 * numbers the original app's Deployed Summary page shows, ported into this
 * backend's own dashboard.service.js (Deployed Summary only reads
 * SHEETS.DEPLOYED, so it doesn't drag in Accounts & Collection's
 * report-suite dependencies).
 */
export function DeployedSummaryPage() {
  const { data, loading, error, reload } = useAsync(fetchDeployedSummary, []);
  const [typeVal, setTypeVal] = useState('');
  const [sizeVal, setSizeVal] = useState('');
  const [selection, setSelection] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const [monthExporting, setMonthExporting] = useState('');
  const [categoryExporting, setCategoryExporting] = useState('');

  const sizeOptions = useMemo(() => {
    if (!data) return [];
    if (typeVal && data.typeSizes && data.typeSizes[typeVal]) return data.typeSizes[typeVal];
    return data.sizes || [];
  }, [data, typeVal]);

  const onTypeChange = (v) => { setTypeVal(v); setSizeVal(''); setSelection(null); };
  const onSizeChange = (v) => { setSizeVal(v); setSelection(null); };

  const exportToExcel = async () => {
    if (!data || !data.months || !data.months.length) return;
    setExporting(true);
    setExportError('');
    try {
      const { months, rows, types } = data;
      const filterSuffix = typeVal && sizeVal ? ` (${typeVal} — ${sizeVal})` : typeVal ? ` (${typeVal})` : sizeVal ? ` (Size: ${sizeVal})` : '';

      const summaryAoa = [
        [`Category${filterSuffix}`, ...months],
        ...GROUPS.map((grp) => [grp.label, ...months.map((m, mIdx) => getVal(rows[mIdx], grp.key, typeVal, sizeVal, types))])
      ];
      const summarySheet = XLSX.utils.aoa_to_sheet(summaryAoa);
      summarySheet['!cols'] = [{ wch: 20 }, ...months.map(() => ({ wch: 12 }))];

      // "Closing" for the latest month = every container currently deployed
      // — same source the drill-down uses, just for the whole fleet rather
      // than one cell.
      const { containers = [] } = await fetchDeployedDetail(months[0], 'closing', typeVal, sizeVal);
      const detailAoa = [
        ['Container', 'Order No', 'Client Code', 'Client Name', 'Size', 'Type', 'Location', 'Deployed Date', 'Valid Upto'],
        ...containers.map((c) => [c.container, c.orderNo, c.clientCode, c.clientName, c.size, c.type, c.location, c.deployedDate, c.validUpto])
      ];
      const detailSheet = XLSX.utils.aoa_to_sheet(detailAoa);
      detailSheet['!cols'] = [{ wch: 16 }, { wch: 12 }, { wch: 12 }, { wch: 26 }, { wch: 10 }, { wch: 10 }, { wch: 16 }, { wch: 14 }, { wch: 14 }];

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, summarySheet, 'Summary');
      XLSX.utils.book_append_sheet(wb, detailSheet, 'Deployed Containers');
      const stamp = months[0].replace(' ', '-');
      XLSX.writeFile(wb, `Deployed-Summary-${stamp}.xlsx`);
    } catch (e) {
      setExportError(apiErrorMessage(e));
    } finally {
      setExporting(false);
    }
  };

  /** Shared builder for the "all categories for one month" / "one category
   *  for all months" exports — `sections` is [{key, label, containers}],
   *  `format` picks which file actually gets built+saved. */
  const buildSectionedExport = (title, stamp, sections, format) => {
    if (format === 'excel') {
      const wb = XLSX.utils.book_new();
      sections.forEach((sec) => {
        const aoa = [DETAIL_HEADERS, ...sec.containers.map((c) => [c.container, c.orderNo, c.clientCode, c.clientName, c.size, c.type, c.location, c.deployedDate, c.validUpto, c.movement])];
        const sheet = XLSX.utils.aoa_to_sheet(aoa);
        sheet['!cols'] = [{ wch: 16 }, { wch: 12 }, { wch: 12 }, { wch: 26 }, { wch: 10 }, { wch: 10 }, { wch: 16 }, { wch: 14 }, { wch: 14 }, { wch: 10 }];
        XLSX.utils.book_append_sheet(wb, sheet, sec.label.slice(0, 31));
      });
      XLSX.writeFile(wb, `${stamp}.xlsx`);
      return;
    }

    const doc = new jsPDF({ orientation: 'landscape' });
    doc.setFontSize(13);
    doc.text(title, 14, 15);
    let nextY = 22;
    sections.forEach((sec, i) => {
      doc.setFontSize(11);
      doc.text(`${sec.label} (${sec.containers.length})`, 14, nextY);
      if (sec.containers.length) {
        autoTable(doc, {
          startY: nextY + 3,
          head: [DETAIL_HEADERS],
          body: sec.containers.map((c) => [c.container, c.orderNo, c.clientCode, c.clientName, c.size, c.type, c.location, c.deployedDate, c.validUpto, c.movement]),
          styles: { fontSize: 7 },
          headStyles: { fillColor: [5, 35, 121] },
          margin: { top: 22 }
        });
        nextY = doc.lastAutoTable.finalY + 12;
      } else {
        nextY += 10;
      }
      if (nextY > 180 && i < sections.length - 1) { doc.addPage(); nextY = 15; }
    });
    doc.save(`${stamp}.pdf`);
  };

  /** Pick "Export to Excel" or "Export to PDF" for a month column header ->
   *  exports ALL 5 categories for that month (Opening/Addition/Deletion/
   *  Net/Closing) in the chosen format only. */
  const exportMonthAll = async (monthLabel, format) => {
    setMonthExporting(monthLabel);
    setExportError('');
    try {
      const results = await Promise.all(
        GROUPS.map((grp) => fetchDeployedDetail(monthLabel, grp.key, typeVal, sizeVal))
      );
      const sections = GROUPS.map((grp, i) => ({ key: grp.key, label: grp.label, containers: results[i]?.containers || [] }));
      const stamp = `Deployed-${monthLabel.replace(' ', '-')}-All-Categories`;
      buildSectionedExport(`Deployed Summary — ${monthLabel} — All Categories`, stamp, sections, format);
    } catch (e) {
      setExportError(apiErrorMessage(e));
    } finally {
      setMonthExporting('');
    }
  };

  /** Pick "Export to Excel" or "Export to PDF" for a category row label ->
   *  exports that ONE category for ALL months, transposed from the month
   *  export (one sheet/table per month instead of per category). */
  const exportCategoryAll = async (catKey, catLabel, format) => {
    if (!data || !data.months || !data.months.length) return;
    const months = data.months;
    setCategoryExporting(catKey);
    setExportError('');
    try {
      const results = await Promise.all(
        months.map((m) => fetchDeployedDetail(m, catKey, typeVal, sizeVal))
      );
      const sections = months.map((m, i) => ({ key: m, label: m, containers: results[i]?.containers || [] }));
      const stamp = `Deployed-${catKey}-All-Months`;
      buildSectionedExport(`Deployed Summary — ${catLabel} — All Months`, stamp, sections, format);
    } catch (e) {
      setExportError(apiErrorMessage(e));
    } finally {
      setCategoryExporting('');
    }
  };

  return (
    <>
      <PageHeader
        title="Deployed Summary"
        subtitle="Month-wise deployed container movement"
        actions={(
          <>
            <Button variant="secondary" size="sm" loading={exporting} onClick={exportToExcel} disabled={!data?.months?.length}>Export to Excel</Button>
            <Button variant="secondary" size="sm" onClick={reload}>Refresh</Button>
          </>
        )}
      />

      {exportError && <p className={styles.exportError}>{exportError}</p>}

      <Card>
        {loading ? (
          <LoadingState label="Loading deployed summary…" />
        ) : error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : !data || !data.months || data.months.length === 0 ? (
          <EmptyState message="No deployed data found" />
        ) : (
          <DeployedSummaryBody
            data={data}
            typeVal={typeVal}
            sizeVal={sizeVal}
            sizeOptions={sizeOptions}
            selection={selection}
            onTypeChange={onTypeChange}
            onSizeChange={onSizeChange}
            onSelect={setSelection}
            monthExporting={monthExporting}
            onExportMonth={exportMonthAll}
            categoryExporting={categoryExporting}
            onExportCategory={exportCategoryAll}
          />
        )}
      </Card>

      {selection && (
        <DeployedDetailPanel selection={selection} onClose={() => setSelection(null)} />
      )}
    </>
  );
}

function DeployedSummaryBody({ data, typeVal, sizeVal, sizeOptions, selection, onTypeChange, onSizeChange, onSelect, monthExporting, onExportMonth, categoryExporting, onExportCategory }) {
  const { months, rows, types } = data;
  const [kpiMonthIdx, setKpiMonthIdx] = useState(0);
  const currentRow = rows[kpiMonthIdx] || rows[0]; // months[] is newest-first

  const typeOptions = types.map((t) => ({ value: t, label: t }));
  const sizeSelectOptions = sizeOptions.map((s) => ({ value: s, label: s }));
  const monthOptions = months.map((m, i) => ({ value: String(i), label: m }));
  const filterLabel = typeVal && sizeVal ? `${typeVal} — ${sizeVal}` : typeVal || (sizeVal ? `Size: ${sizeVal}` : 'All Containers');

  const cellTone = (key, val) => {
    if (key === 'addition' && val > 0) return styles.pos;
    if (key === 'deletion' && val > 0) return styles.neg;
    if (key === 'net' && val < 0) return styles.neg;
    if (val === 0) return styles.zero;
    return '';
  };

  return (
    <>
      <div className={styles.kpiHead}>
        <label className={styles.filterField}>
          <span className={styles.filterLabel}>Month</span>
          <Select ariaLabel="Month" value={String(kpiMonthIdx)} onChange={(v) => setKpiMonthIdx(Number(v))} options={monthOptions} placeholder={months[0]} />
        </label>
      </div>
      <div className={styles.kpiRow}>
        <StatCard icon="package" tint="info" label="Currently Deployed" value={getVal(currentRow, 'closing', typeVal, sizeVal, types)} />
        <StatCard icon="chev-up" tint="success" label={`${currentRow.month} Addition`} value={getVal(currentRow, 'addition', typeVal, sizeVal, types)} />
        <StatCard icon="chev-down" tint="error" label={`${currentRow.month} Deletion`} value={getVal(currentRow, 'deletion', typeVal, sizeVal, types)} />
        <StatCard icon="refresh" tint="neutral" label={`${currentRow.month} Net`} value={getVal(currentRow, 'net', typeVal, sizeVal, types)} />
      </div>

      <div className={styles.filters}>
        <label className={styles.filterField}>
          <span className={styles.filterLabel}>Type</span>
          <Select ariaLabel="Type" value={typeVal} onChange={onTypeChange} options={[{ value: '', label: 'All Types' }, ...typeOptions]} placeholder="All Types" />
        </label>
        <label className={styles.filterField}>
          <span className={styles.filterLabel}>Size</span>
          <Select ariaLabel="Size" value={sizeVal} onChange={onSizeChange} options={[{ value: '', label: 'All Sizes' }, ...sizeSelectOptions]} placeholder="All Sizes" />
        </label>
        <span className={styles.activeLabel}>{filterLabel}</span>
      </div>

      <p className={styles.sectionTitle}>Month-wise Movement</p>
      <div className={styles.tableWrap}>
        <table className={styles.dsTable}>
          <thead>
            <tr>
              <th>Category</th>
              {months.map((m) => (
                <th key={m}>
                  <div className={styles.monthHead}>
                    <span>{monthExporting === m ? 'Exporting…' : m}</span>
                    <span className={styles.menuScale}>
                      <ActionMenu
                        actions={[
                          { label: 'Export to Excel', onClick: () => onExportMonth(m, 'excel') },
                          { label: 'Export to PDF', onClick: () => onExportMonth(m, 'pdf') }
                        ]}
                      />
                    </span>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {GROUPS.map((grp) => (
              <tr key={grp.key}>
                <td className={styles.rowHead}>
                  <div className={styles.rowHeadWrap}>
                    <span>{categoryExporting === grp.key ? 'Exporting…' : grp.label}</span>
                    <span className={styles.menuScale}>
                      <ActionMenu
                        actions={[
                          { label: 'Export to Excel', onClick: () => onExportCategory(grp.key, grp.label, 'excel') },
                          { label: 'Export to PDF', onClick: () => onExportCategory(grp.key, grp.label, 'pdf') }
                        ]}
                      />
                    </span>
                  </div>
                </td>
                {months.map((m, mIdx) => {
                  const val = getVal(rows[mIdx], grp.key, typeVal, sizeVal, types);
                  const isSelected = selection && selection.monthIdx === mIdx && selection.category === grp.key;
                  return (
                    <td key={m} className={isSelected ? styles.highlight : ''}>
                      <button
                        type="button"
                        className={`${styles.cellBtn} ${cellTone(grp.key, val)}`}
                        onClick={() => onSelect({ monthIdx: mIdx, category: grp.key, monthLabel: months[mIdx], typeVal, sizeVal })}
                      >
                        {val}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function DeployedDetailPanel({ selection, onClose }) {
  const { data, loading, error, reload } = useAsync(
    () => fetchDeployedDetail(selection.monthLabel, selection.category, selection.typeVal, selection.sizeVal),
    [selection.monthLabel, selection.category, selection.typeVal, selection.sizeVal]
  );
  const containers = data?.containers || [];
  const catLabel = selection.category.charAt(0).toUpperCase() + selection.category.slice(1);
  const filterLabel = selection.typeVal ? (selection.sizeVal ? `${selection.typeVal} — ${selection.sizeVal}` : selection.typeVal) : (selection.sizeVal ? `Size: ${selection.sizeVal}` : 'All Types');

  const rows = containers.map((c) => ({
    row: [c.container, c.orderNo, c.clientCode, c.clientName, c.size, c.type, c.location, c.deployedDate, c.validUpto, c.movement],
    _rowNum: c.container
  }));

  const fileStamp = `${selection.monthLabel.replace(' ', '-')}-${selection.category}`;

  const exportDetailToExcel = () => {
    if (!containers.length) return;
    const aoa = [DETAIL_HEADERS, ...containers.map((c) => [c.container, c.orderNo, c.clientCode, c.clientName, c.size, c.type, c.location, c.deployedDate, c.validUpto, c.movement])];
    const sheet = XLSX.utils.aoa_to_sheet(aoa);
    sheet['!cols'] = [{ wch: 16 }, { wch: 12 }, { wch: 12 }, { wch: 26 }, { wch: 10 }, { wch: 10 }, { wch: 16 }, { wch: 14 }, { wch: 14 }, { wch: 10 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, `${catLabel} ${selection.monthLabel}`.slice(0, 31));
    XLSX.writeFile(wb, `Deployed-${fileStamp}.xlsx`);
  };

  const exportDetailToPdf = () => {
    if (!containers.length) return;
    const doc = new jsPDF({ orientation: 'landscape' });
    doc.setFontSize(13);
    doc.text(`Deployed Summary — ${selection.monthLabel} — ${catLabel}`, 14, 15);
    doc.setFontSize(9);
    doc.text(`${filterLabel} · ${containers.length} container${containers.length === 1 ? '' : 's'}`, 14, 21);
    autoTable(doc, {
      startY: 26,
      head: [DETAIL_HEADERS],
      body: containers.map((c) => [c.container, c.orderNo, c.clientCode, c.clientName, c.size, c.type, c.location, c.deployedDate, c.validUpto, c.movement]),
      styles: { fontSize: 8 },
      headStyles: { fillColor: [5, 35, 121] }
    });
    doc.save(`Deployed-${fileStamp}.pdf`);
  };

  return (
    <Card
      title={`${selection.monthLabel} — ${catLabel}`}
      actions={(
        <>
          <Button variant="secondary" size="sm" onClick={exportDetailToExcel} disabled={!containers.length}>Export to Excel</Button>
          <Button variant="secondary" size="sm" onClick={exportDetailToPdf} disabled={!containers.length}>Export to PDF</Button>
          <Button variant="secondary" size="sm" onClick={onClose}>Close</Button>
        </>
      )}
    >
      <p className={styles.hint}>{filterLabel} · {containers.length} container{containers.length === 1 ? '' : 's'}</p>
      {loading ? (
        <LoadingState label="Loading details…" />
      ) : error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : containers.length === 0 ? (
        <EmptyState message="No matching containers for this selection" />
      ) : (
        <DataGrid
          headers={DETAIL_HEADERS}
          rows={rows}
          rowKey={(r) => r._rowNum}
          renderRow={(values) => values.map((v, i) => <td key={i}>{renderCellValue(v)}</td>)}
        />
      )}
    </Card>
  );
}
