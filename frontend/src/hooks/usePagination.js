/**
 * Every page in this app lists all of its (already-fetched, already-filtered)
 * rows at once — no Prev/Next paging. Kept as a hook with this shape so every
 * call site (`usePagination(filtered, 10)`) and the shared <Pagination/>
 * control (which already renders nothing once totalPages <= 1) need no
 * changes: this just always reports "one page containing everything".
 */
export function usePagination(rows) {
  return {
    page: 1,
    totalPages: 1,
    pageRows: rows,
    setPage: () => {},
    nextPage: () => {},
    prevPage: () => {},
    resetPage: () => {}
  };
}
