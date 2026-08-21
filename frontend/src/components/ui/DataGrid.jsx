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
  className = ''
}) {
  if (error) return <ErrorState message={error} onRetry={onRetry} />;
  // The real header row stays visible while loading — it's context the user
  // already has (what's coming), so replacing it with a spinner too was
  // throwing away information as well as looking like the page had frozen.
  if (!loading && !rows.length) return <EmptyState message={emptyMessage} />;

  return (
    <div className={styles.scrollWrap}>
      <table className={`${styles.table} ${className}`}>
        <thead>
          <tr>
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
              <td colSpan={headers.length + (renderActions ? 1 : 0)} className={styles.skeletonCell}>
                <SkeletonTable columns={Math.max(headers.length, 3)} />
              </td>
            </tr>
          </tbody>
        ) : (
          <tbody>
            {rows.map((r, i) => {
              const values = r.row || r;
              return (
                <tr key={rowKey(r, i)}>
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
