import styles from './DataGrid.module.css';
import { EmptyState } from './EmptyState.jsx';
import { ErrorState } from './ErrorState.jsx';
import { renderCellValue } from './CellValue.jsx';
import { SkeletonTable } from './Skeleton.jsx';

/**
 * Generic table — headers + rows (array of {row: [...cells], ...meta}),
 * optional per-row actions renderer. This app's equivalent of the main
 * app's DataTable, built independently.
 */
export function DataGrid({
  headers = [],
  rows = [],
  renderRow,
  renderActions,
  loading,
  error,
  onRetry,
  emptyMessage = 'No records found',
  rowKey = (r, i) => r._rowNum ?? r.id ?? i,
  className = '',
  /* Opt-in row-selection checkbox column — pass selectedKeys/onToggleRow/
     onToggleAll to turn it on. Generic here (not baked into any one page)
     so any grid can adopt bulk actions the same way Renew & Document did
     first, without a parallel table implementation. */
  selectable = false,
  selectedKeys,
  onToggleRow,
  onToggleAll
}) {
  if (error) return <ErrorState message={error} onRetry={onRetry} />;
  // The real header row stays visible while loading — it's context the user
  // already has (what's coming), so replacing it with a spinner too was
  // throwing away information as well as looking like the page had frozen.
  if (!loading && !rows.length) return <EmptyState message={emptyMessage} />;

  const extraCols = (selectable ? 1 : 0) + (renderActions ? 1 : 0);
  const allSelected = selectable && rows.length > 0 && rows.every((r, i) => selectedKeys?.has(rowKey(r, i)));

  return (
    <div className={styles.scrollWrap}>
      <table className={`${styles.table} ${className}`}>
        <thead>
          <tr>
            {selectable && (
              <th className={styles.selectCol}>
                <input type="checkbox" checked={allSelected} onChange={onToggleAll} aria-label="Select all rows" />
              </th>
            )}
            {headers.map((h, i) => <th key={i}>{h}</th>)}
            {renderActions && <th className={styles.actionsCol}>Actions</th>}
          </tr>
        </thead>
        {loading ? (
          // Every load shows the skeleton, initial or a manual Refresh
          // alike — the app is RAW app<->sheet now (no cache, no
          // optimistic local patches to protect from being hidden), so
          // there's no longer a reason to suppress this: a Refresh click
          // with no visible feedback looks broken even when it's working.
          <tbody>
            <tr>
              <td colSpan={headers.length + extraCols} className={styles.skeletonCell}>
                <SkeletonTable columns={Math.max(headers.length, 3)} />
              </td>
            </tr>
          </tbody>
        ) : (
          <tbody>
            {rows.map((r, i) => {
              const values = r.row || r;
              const key = rowKey(r, i);
              return (
                <tr key={key}>
                  {selectable && (
                    <td className={styles.selectCol}>
                      <input
                        type="checkbox"
                        checked={!!selectedKeys?.has(key)}
                        onChange={() => onToggleRow(key)}
                        aria-label={`Select row ${i + 1}`}
                      />
                    </td>
                  )}
                  {renderRow ? renderRow(values, r, i) : values.map((v, ci) => <td key={ci}>{renderCellValue(v)}</td>)}
                  {renderActions && <td className={styles.actionsCol}>{renderActions(r, i)}</td>}
                </tr>
              );
            })}
          </tbody>
        )}
      </table>
    </div>
  );
}
