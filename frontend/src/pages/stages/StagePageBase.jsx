import { useMemo, useState } from 'react';
import { PageHeader } from '../../components/ui/PageHeader.jsx';
import { Card } from '../../components/ui/Card.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { SearchBar } from '../../components/ui/SearchBar.jsx';
import { Pagination } from '../../components/ui/Pagination.jsx';
import { DataGrid } from '../../components/ui/DataGrid.jsx';
import { StatusBadge } from '../../components/ui/StatusBadge.jsx';
import { renderCellValue } from '../../components/ui/CellValue.jsx';
import { ALL_STAGES, stageDisplayNumber, stageCaption, isReadOnlyStage } from '../../constants/stages.js';
import { formatActionTimestamp } from '../../utils/formatDateTime.js';
import { useAsync } from '../../hooks/useAsync.js';
import { usePagination } from '../../hooks/usePagination.js';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import { usePermission } from '../../hooks/usePermission.js';
import { fetchStageList } from '../../services/stage.service.js';
import { isRateOrAmountHeader } from '../../utils/isRateOrAmountHeader.js';
import { StageDetailModal } from './StageDetailModal.jsx';
import styles from './StagePageBase.module.css';

/**
 * Shared, fully-working shell for Off-Lease Stage 1..8 pages — one component
 * parametrized by stageNumber. Lists the rows currently pending at this
 * stage, and opens StageDetailModal (backed by stageFields.js) to view/edit
 * this stage's specific fields for a row.
 */
/** undefined = sheet unreadable, null = read but no row, object = found. */
const dotState = (v) => (v === undefined ? 'unread' : v ? 'found' : 'missing');
const DOT_TITLE = { found: 'record found', missing: 'no record', unread: 'sheet unavailable' };

/** The FMS chain as three compact dots, so a whole column of them can be
 *  scanned down the page. Full detail is behind View. */
function FmsDots({ item }) {
  const steps = [
    [8, 'Movement', item?.movement],
    [9, 'Transport', item?.transport],
    [10, 'Site Delivery', item?.delivery]
  ];
  return (
    <span className={styles.dots}>
      {steps.map(([n, label, value]) => {
        const state = dotState(value);
        return (
          <span
            key={n}
            className={`${styles.dot} ${styles[`dot_${state}`]}`}
            title={`Stage ${n} — ${label}: ${DOT_TITLE[state]}`}
          >
            {n}
          </span>
        );
      })}
    </span>
  );
}

export function StagePageBase({ stageNumber, embedded }) {
  // ALL_STAGES, not STAGES: a retired stage's direct route still has to label
  // itself correctly for anyone opening historical data.
  const stage = ALL_STAGES.find((s) => s.number === stageNumber);
  const displayNumber = stageDisplayNumber(stageNumber);
  const permKey = `offlease${stageNumber}`;
  const { canAct } = usePermission();
  /* A read-only stage is never editable, whatever the permission says — it has
     no form to open, so the Open button and the detail modal are both gone. */
  const readOnly = isReadOnlyStage(stageNumber);
  const canEdit = !readOnly && canAct(permKey);

  const { data, loading, error, reload } = useAsync(() => fetchStageList(stageNumber), [stageNumber]);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search);
  const [activeRow, setActiveRow] = useState(null);

  const headers = data?.headers || [];
  const rows = data?.data || [];

  const visibleIdx = useMemo(
    () => headers.map((_, i) => i).filter((i) => !isRateOrAmountHeader(headers[i])),
    [headers]
  );
  const visibleHeaders = useMemo(() => visibleIdx.map((i) => headers[i]), [visibleIdx, headers]);

  const filteredRows = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => (r.row || []).some((cell) => String(cell ?? '').toLowerCase().includes(q)));
  }, [rows, debouncedSearch]);

  const { page, totalPages, pageRows, setPage, nextPage, prevPage } = usePagination(filteredRows, 10);

  return (
    <>
      {!embedded && (
        <PageHeader
          title={displayNumber ? `Stage ${displayNumber}` : (stage?.label || '')}
          subtitle={displayNumber ? (stage?.label || '') : 'Retired stage — historical records only'}
        />
      )}
      <Card>
        <div className={styles.toolbar}>
          <SearchBar value={search} onChange={setSearch} placeholder="Search by container, lease ID, client…" />
          <span className={styles.count}>
            {filteredRows.length} pending record{filteredRows.length === 1 ? '' : 's'}
          </span>
        </div>

        <DataGrid
          headers={[
            ...visibleHeaders,
            ...(readOnly ? ['Status'] : []),
            /* Budget in the header, so every cell below reads as "elapsed"
               without repeating "of 1h" on every row. */
            ...(data?.tatBudget ? [`TAT (${data.tatBudget})`] : [])
          ]}
          rows={pageRows}
          loading={loading}
          error={error}
          onRetry={reload}
          emptyMessage={`No pending records for ${stageCaption(stageNumber)}`}
          rowKey={(r) => r._rowNum}
          renderRow={(values, item) => [
            ...visibleIdx.map((i) => <td key={i}>{renderCellValue(values[i] ?? '')}</td>),
            /* Status here is the FMS pipeline, not this stage's own status —
               every row in this list is pending at this stage by definition
               (that is what puts it in the queue), so "Pending" said nothing.
               What a reader wants to know is how far the container has got
               through STAGE-8 -> 9 -> 10. */
            ...(readOnly ? [<td key="status"><FmsDots item={item} /></td>] : []),
            ...(data?.tatBudget
              ? [<td key="tat">{item?.tat
                ? (
                  <span
                    className={item.tat.delayed ? styles.tatLate : styles.tatOk}
                    title={`Waiting since ${formatActionTimestamp(item.tat.startedAt)}`}
                  >
                    {item.tat.elapsed}{item.tat.delayed ? ` · ${item.tat.overdueBy} over` : ''}
                  </span>
                )
                : '—'}</td>]
              : [])
          ]}
          /* A read-only stage still opens — canEdit is false there, so the
             button reads View and the modal comes up with its fields locked
             and no submit. Looking at a record is not editing it. */
          renderActions={(r) => (
            <Button size="sm" variant={canEdit ? 'primary' : 'secondary'} onClick={() => setActiveRow(r)}>
              {canEdit ? 'Open' : 'View'}
            </Button>
          )}
        />

        <Pagination page={page} totalPages={totalPages} onPrev={prevPage} onNext={nextPage} onPage={setPage} />
      </Card>

      {activeRow && (
        <StageDetailModal
          stageNumber={stageNumber}
          containerNo={activeRow.row[0]}
          readOnly={!canEdit}
          identityOnly={readOnly}
          /* STAGE-8 / STAGE-9 detail for this container, matched server-side.
             Shown here rather than as grid columns — ten mostly-blank columns
             made the table unreadable. */
          movement={activeRow.movement}
          transport={activeRow.transport}
          delivery={activeRow.delivery}
          onClose={() => setActiveRow(null)}
          onSaved={() => { setActiveRow(null); reload(); }}
        />
      )}
    </>
  );
}
