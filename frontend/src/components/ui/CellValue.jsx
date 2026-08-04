const URL_RE = /^https?:\/\//i;

/**
 * Renders a raw sheet-cell value for display in a table. A bare Drive/URL
 * link (agreement PDFs, PO files, etc.) becomes a small clickable icon
 * instead of dumping the full raw URL text into the table — click opens it
 * in a new tab.
 */
export function renderCellValue(v) {
  const s = v == null ? '' : String(v);
  const trimmed = s.trim();
  if (URL_RE.test(trimmed)) {
    return (
      <a href={trimmed} target="_blank" rel="noopener noreferrer" title="Open file" onClick={(e) => e.stopPropagation()}>
        📎
      </a>
    );
  }
  return s;
}
