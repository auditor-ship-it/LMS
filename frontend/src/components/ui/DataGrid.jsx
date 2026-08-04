import styles from './DataGrid.module.css';
import { LoadingState } from './LoadingState.jsx';
import { EmptyState } from './EmptyState.jsx';
import { ErrorState } from './ErrorState.jsx';
import { renderCellValue } from './CellValue.jsx';

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
  if (loading) return <LoadingState />;
  if (error) return <ErrorState message={error} onRetry={onRetry} />;
  if (!rows.length) return <EmptyState message={emptyMessage} />;

  return (
    <div className={styles.scrollWrap}>
      <table className={`${styles.table} ${className}`}>
        <thead>
          <tr>
            {headers.map((h, i) => <th key={i}>{h}</th>)}
            {renderActions && <th className={styles.actionsCol}>Actions</th>}
          </tr>
        </thead>
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
      </table>
    </div>
  );
}
