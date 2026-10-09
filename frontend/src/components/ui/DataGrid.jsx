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
  onToggleAll,
  /* Opt-in: makes the whole row clickable (e.g. to open a detail view),
     independent of renderActions' own buttons — those live in their own
     cell, which stops the click before it reaches the row, so a button
     press never also triggers onRowClick. */
  onRowClick,
  /* When set, the table body scrolls inside this height and thead stays
     sticky at the top of the wrap. Without a vertical scrollport, sticky
     headers never activate (overflow-x alone still creates a scroll
     container that traps sticky within an ever-growing wrap). */
  bodyMaxHeight,
  /* Opt-in, one entry per `headers` column (any CSS width, e.g. '160px' or
     '2fr' won't work here — table <col> takes a length/percentage, not a
     fr unit — so use px or %). Only meaningful with a caller that also sets
     table-layout: fixed (e.g. via `className`): fixed layout otherwise
     divides the table equally across every column regardless of content,
     which starves a column like "Customer Name" to the same width as
     "PO PDF". Omit to leave sizing exactly as before (equal division). */
  colWidths
}) {
  if (error) return <ErrorState message={error} onRetry={onRetry} />;
  // The real header row stays visible while loading — it's context the user
  // already has (what's coming), so replacing it with a spinner too was
  // throwing away information as well as looking like the page had frozen.
  if (!loading && !rows.length) return <EmptyState message={emptyMessage} />;

  const extraCols = (selectable ? 1 : 0) + (renderActions ? 1 : 0);
  const allSelected = selectable && rows.length > 0 && rows.every((r, i) => selectedKeys?.has(rowKey(r, i)));

  return (
    <div
      className={`${styles.scrollWrap}${bodyMaxHeight ? ` ${styles.scrollWrapY}` : ''}`}
      style={bodyMaxHeight ? { maxHeight: bodyMaxHeight } : undefined}
    >
      <table className={`${styles.table} ${className}`}>
        {colWidths && (
          <colgroup>
            {/* Fixed px, not '1%': under table-layout: fixed a column this
                narrow has no room left once a caller pads every cell (see
                e.g. LeaseExpiryPage's own wrapTable rule) — the checkbox
                itself overflowed into the next column's text at '1%'. */}
            {selectable && <col style={{ width: '44px' }} />}
            {colWidths.map((w, i) => <col key={i} style={{ width: w }} />)}
            {renderActions && <col style={{ width: '44px' }} />}
          </colgroup>
        )}
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
                <tr
                  key={key}
                  onClick={onRowClick ? () => onRowClick(r, i) : undefined}
                  className={onRowClick ? styles.clickableRow : undefined}
                >
                  {selectable && (
                    <td className={styles.selectCol} onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={!!selectedKeys?.has(key)}
                        onChange={() => onToggleRow(key)}
                        aria-label={`Select row ${i + 1}`}
                      />
                    </td>
                  )}
                  {renderRow ? renderRow(values, r, i) : values.map((v, ci) => <td key={ci}>{renderCellValue(v)}</td>)}
                  {renderActions && <td className={styles.actionsCol} onClick={(e) => e.stopPropagation()}>{renderActions(r, i)}</td>}
                </tr>
              );
            })}
          </tbody>
        )}
      </table>
    </div>
  );
}
