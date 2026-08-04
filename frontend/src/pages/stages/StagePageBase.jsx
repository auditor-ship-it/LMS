import { useMemo, useState } from 'react';
import { PageHeader } from '../../components/ui/PageHeader.jsx';
import { Card } from '../../components/ui/Card.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { SearchBar } from '../../components/ui/SearchBar.jsx';
import { Pagination } from '../../components/ui/Pagination.jsx';
import { DataGrid } from '../../components/ui/DataGrid.jsx';
import { renderCellValue } from '../../components/ui/CellValue.jsx';
import { STAGES } from '../../constants/stages.js';
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
export function StagePageBase({ stageNumber, embedded }) {
  const stage = STAGES.find((s) => s.number === stageNumber);
  const permKey = `offlease${stageNumber}`;
  const { canAct } = usePermission();
  const canEdit = canAct(permKey);

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
      {!embedded && <PageHeader title={`Stage ${stageNumber}`} subtitle={stage?.label || ''} />}
      <Card>
        <div className={styles.toolbar}>
          <SearchBar value={search} onChange={setSearch} placeholder="Search by container, lease ID, client…" />
          <span className={styles.count}>
            {filteredRows.length} pending record{filteredRows.length === 1 ? '' : 's'}
          </span>
        </div>

        <DataGrid
          headers={visibleHeaders}
          rows={pageRows}
          loading={loading}
          error={error}
          onRetry={reload}
          emptyMessage={`No pending records for Stage ${stageNumber} — ${stage?.label || ''}`}
          rowKey={(r) => r._rowNum}
          renderRow={(values) => visibleIdx.map((i) => <td key={i}>{renderCellValue(values[i] ?? '')}</td>)}
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
          stageLabel={stage?.label || ''}
          containerNo={activeRow.row[0]}
          readOnly={!canEdit}
          onClose={() => setActiveRow(null)}
          onSaved={() => { setActiveRow(null); reload(); }}
        />
      )}
    </>
  );
}
