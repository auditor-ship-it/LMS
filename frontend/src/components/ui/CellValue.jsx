/* An absolute link, or one of our own document-proxy paths. Attachments stored
   before the Drive move are served through /api/admin/docs?id=… rather than a
   drive.google.com URL; without the second form those cells dumped the raw
   path into the grid instead of showing the clip. */
const URL_RE = /^(https?:\/\/|\/api\/)/i;

/**
 * Renders a raw sheet-cell value for display in a table. A bare Drive/URL
 * link (agreement PDFs, PO files, etc.) becomes a small clickable icon
 * instead of dumping the full raw URL text into the table — click opens it
 * in a new tab.
 */
export function renderCellValue(v) {
  const s = v == null ? '' : String(v);
  const trimmed = s.trim();
  // An empty cell reads as a gap in a dense grid — an em dash makes "nothing
  // recorded" explicit and keeps column alignment legible.
  if (trimmed === '') return <span className="cellEmpty">—</span>;
  if (URL_RE.test(trimmed)) {
    return (
      <a href={trimmed} target="_blank" rel="noopener noreferrer" title="Open file" onClick={(e) => e.stopPropagation()}>
        📎
      </a>
    );
  }
  return s;
}
