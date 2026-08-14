/**
 * jsPDF layout primitives for the Off-Lease Container Report, reproducing the
 * original Apps Script printout: a bordered header card with a blue stage
 * pill, a 3-across grid of small-caps-label-over-value cells, then one card
 * per completed stage.
 *
 * Drawn with primitives rather than autoTable because the report is a field
 * grid, not a tabular dataset — autoTable's row/column model has no way to
 * express the two-line cell (label above value), the pill chrome, or the
 * per-card rounded borders.
 *
 * All positions are millimetres on A4 portrait. Sizes were taken off the
 * reference printout, so cells/rows here match it closely.
 */

export const PAGE_W = 210;
export const PAGE_H = 297;
export const MARGIN = 12;
export const CONTENT_W = PAGE_W - MARGIN * 2;

/** Bottom edge past which content moves to a new page. */
const BOTTOM = PAGE_H - 16;

const NAVY = [15, 35, 75];      // headings and values
const BLUE = [37, 99, 235];     // stage numbers, order no, stage pill
const MUTED = [100, 116, 139];  // field labels, meta
const FAINT = [148, 163, 184];  // "Completed" pill text
const BORDER = [226, 232, 240];
const PILL_BG = [241, 245, 249];

/* Metrics for the label-over-value grid. Scaled down ~25% from the original
   printout's proportions — the report had grown to several pages and the
   identity/stage cards were the bulk of it, so everything here is tightened
   to fit more per page while staying legible at 100%. */
const PAD = 4;
const ROW_MIN = 12.4;
const LINE_H = 4;
const LABEL_DY = 4;     // label baseline below the row top
const VALUE_DY = 8.4;   // first value line baseline below the row top

/* Type scale, in points. Kept in one place so the whole document can be
   resized coherently rather than by nudging individual call sites. */
const FS_TITLE = 15;
const FS_SUBTITLE = 8.5;
const FS_CARD_TITLE = 13;
const FS_LABEL = 5.9;
const FS_VALUE = 9;
const FS_STAGE_NUM = 7.5;
const FS_STAGE_LABEL = 9.5;
const FS_META = 7;

const URL_RE = /^https?:\/\//i;

export function isUrl(v) {
  return URL_RE.test(String(v || '').trim());
}

function setText(doc, color, size, style = 'bold', charSpace = 0) {
  doc.setTextColor(color[0], color[1], color[2]);
  doc.setFontSize(size);
  doc.setFont('helvetica', style);
  doc.setCharSpace(charSpace);
}

function line(doc, x1, y1, x2, y2) {
  doc.setDrawColor(BORDER[0], BORDER[1], BORDER[2]);
  doc.setLineWidth(0.2);
  doc.line(x1, y1, x2, y2);
}

/**
 * Rounded pill sized to its text. `edgeX` is the right edge by default, or the
 * left edge with `align: 'left'` — the pill sizes itself, so callers can't
 * place it without one or the other. Returns its width.
 */
export function drawPill(doc, edgeX, centerY, label, opts = {}) {
  const { size = 9, color = BLUE, border = BLUE, fill = null, padX = 5 } = opts;
  setText(doc, color, size, 'bold');
  const w = doc.getTextWidth(label) + padX * 2;
  const h = size * 0.352 + 4;
  const x = opts.align === 'left' ? edgeX : edgeX - w;
  const y = centerY - h / 2;

  doc.setDrawColor(border[0], border[1], border[2]);
  doc.setLineWidth(0.3);
  if (fill) {
    doc.setFillColor(fill[0], fill[1], fill[2]);
    doc.roundedRect(x, y, w, h, h / 2, h / 2, 'FD');
  } else {
    doc.roundedRect(x, y, w, h, h / 2, h / 2, 'S');
  }
  setText(doc, color, size, 'bold');
  doc.text(label, x + w / 2, centerY + size * 0.125, { align: 'center' });
  doc.setCharSpace(0);
  return w;
}

/**
 * Tracks the open card so borders can be drawn once its height is known, and
 * so a card spanning a page break gets a closed border on each page rather
 * than one rectangle running off the bottom.
 */
export function createReport(doc) {
  let y = MARGIN;
  let cardTop = null;

  const strokeCard = (top, bottom) => {
    if (top == null || bottom - top < 1) return;
    doc.setDrawColor(BORDER[0], BORDER[1], BORDER[2]);
    doc.setLineWidth(0.3);
    doc.roundedRect(MARGIN, top, CONTENT_W, bottom - top, 3, 3, 'S');
  };

  return {
    get y() { return y; },
    set y(v) { y = v; },

    openCard() { cardTop = y; },
    closeCard() { strokeCard(cardTop, y); cardTop = null; },

    /** Guarantee `h` mm of room, breaking the page (and the card) if needed.
     *  Returns true when a page break happened, so callers can skip the
     *  separator line that would otherwise sit at the top of the new card. */
    ensure(h) {
      if (y + h <= BOTTOM) return false;
      if (cardTop != null) strokeCard(cardTop, y);
      doc.addPage();
      y = MARGIN;
      if (cardTop != null) cardTop = y;
      return true;
    },

    inCard() { return cardTop != null; }
  };
}

/**
 * Company mark, top-right of the title block. Uses the real logo when
 * brand.js carries one; otherwise sets the wordmark in type so the document
 * is still branded. Returns the bottom of whatever it drew.
 */
export function drawBrand(doc, y, brand) {
  const right = MARGIN + CONTENT_W;

  if (brand?.logoDataUri) {
    /* Sized by height, not width: the Crystal mark is a wide lockup (3.84:1),
       so a fixed width made it too short to read. Capped on width as well so
       a squarer replacement can't run into the title. */
    const MAX_H = 11;
    const MAX_W = 52;
    try {
      // Aspect from the image itself, so the mark is never squashed.
      const props = doc.getImageProperties(brand.logoDataUri);
      const aspect = props.width / props.height;
      let h = MAX_H;
      let w = h * aspect;
      if (w > MAX_W) { w = MAX_W; h = w / aspect; }
      const top = y - 5;
      doc.addImage(brand.logoDataUri, 'PNG', right - w, top, w, h);
      return top + h;
    } catch {
      // Unreadable/!PNG data URI — fall through to the wordmark rather than
      // failing the whole export.
    }
  }

  setText(doc, NAVY, 15, 'bold');
  doc.text(String(brand?.name || ''), right, y, { align: 'right' });
  if (brand?.tagline) {
    setText(doc, MUTED, 7, 'normal', 0.2);
    doc.text(String(brand.tagline), right, y + 5, { align: 'right' });
    doc.setCharSpace(0);
    return y + 5;
  }
  return y;
}

/** Report title block, outside any card. */
export function drawTitle(doc, y, title, subtitle) {
  setText(doc, NAVY, FS_TITLE, 'bold');
  doc.text(title, MARGIN, y);
  if (subtitle) {
    setText(doc, MUTED, FS_SUBTITLE, 'normal');
    doc.text(subtitle, MARGIN, y + 6);
    return y + 6;
  }
  return y;
}

/** Card header band: big container number, client line, blue stage pill. */
export function drawHeaderBand(rpt, doc, { container, subtitle, pill }) {
  const h = 16;
  rpt.ensure(h);
  const y = rpt.y;

  setText(doc, NAVY, FS_CARD_TITLE, 'bold');
  doc.text(String(container || ''), MARGIN + PAD + 1, y + 7.8);

  if (subtitle) {
    setText(doc, MUTED, 7.5, 'normal');
    doc.text(String(subtitle), MARGIN + PAD + 1, y + 12.4);
  }
  if (pill) drawPill(doc, MARGIN + CONTENT_W - PAD - 1, y + h / 2, String(pill), { size: 8.5, padX: 5 });

  rpt.y = y + h;
}

/**
 * Stage strip — blue "Stage N", bold title, grey Completed pill, right-aligned
 * "date · user". Drawn as the first row of its own card, so no rule above it.
 */
export function drawStageHeader(rpt, doc, { stage, label, status, meta }) {
  const h = 9;
  rpt.ensure(h + ROW_MIN); // never orphan the heading from its first field row
  const y = rpt.y;
  const midY = y + h / 2;
  let x = MARGIN + PAD;

  // `stage` is null for a retired stage, whose number now belongs to another.
  if (stage != null) {
    setText(doc, BLUE, FS_STAGE_NUM, 'bold');
    const stageTxt = `Stage ${stage}`;
    doc.text(stageTxt, x, midY + 1.1);
    x += doc.getTextWidth(stageTxt) + 3;
  }

  setText(doc, NAVY, FS_STAGE_LABEL, 'bold');
  doc.text(String(label || ''), x, midY + 1.2);
  x += doc.getTextWidth(String(label || '')) + 3;

  if (status) {
    x += drawPill(doc, x, midY, status, {
      size: 6.2, color: FAINT, border: BORDER, fill: PILL_BG, padX: 3.5, align: 'left'
    }) + 3;
  }

  // Right-aligned; dropped rather than allowed to collide on a narrow row.
  if (meta) {
    setText(doc, MUTED, FS_META, 'normal');
    const metaW = doc.getTextWidth(String(meta));
    const metaX = MARGIN + CONTENT_W - PAD;
    if (metaX - metaW > x) doc.text(String(meta), metaX, midY + 1.2, { align: 'right' });
  }

  rpt.y = y + h;
}

/**
 * Grid of {label, value} cells. Columns follow the reference printout: up to
 * three across, but a section with fewer fields spreads them over that many
 * columns instead (a two-field stage renders as two half-width cells, not two
 * thirds and a gap).
 *
 * Rules are drawn only *between* cells — the card's rounded border supplies
 * the outer edge — and a short final row gets one rule after its last cell,
 * matching the reference.
 *
 * URL values become a clickable "Open file" link; the reference's 📎 glyph
 * isn't in jsPDF's standard-font encoding, and a raw 100-character Drive URL
 * doesn't fit a 60mm cell.
 */
export function drawFieldGrid(rpt, doc, items, maxCols = 3) {
  if (!items.length) return;
  const cols = Math.max(1, Math.min(items.length, maxCols));
  const colW = CONTENT_W / cols;
  const textW = colW - PAD * 2;

  for (let i = 0; i < items.length; i += cols) {
    const rowItems = items.slice(i, i + cols);

    const measured = rowItems.map((it) => {
      const raw = it.value == null || it.value === '' ? '—' : String(it.value);
      const link = isUrl(raw);
      setText(doc, NAVY, FS_VALUE, 'bold');
      return { it, link, href: link ? raw.trim() : '', lines: link ? ['Open file'] : doc.splitTextToSize(raw, textW) };
    });

    const rowH = Math.max(ROW_MIN, VALUE_DY + 1.6 + (Math.max(...measured.map((m) => m.lines.length)) - 1) * LINE_H);

    // A rule separates this row from the one above — unless it is the first
    // row on the page/card, where the card border already closes it off.
    const broke = rpt.ensure(rowH);
    if (!broke) line(doc, MARGIN, rpt.y, MARGIN + CONTENT_W, rpt.y);
    const y = rpt.y;

    measured.forEach((m, ci) => {
      const cx = MARGIN + ci * colW;

      setText(doc, MUTED, FS_LABEL, 'bold', 0.2);
      doc.text(String(m.it.label || '').toUpperCase(), cx + PAD, y + LABEL_DY);
      doc.setCharSpace(0);

      let ty = y + VALUE_DY;
      if (m.link) {
        setText(doc, BLUE, FS_VALUE, 'bold');
        doc.textWithLink('Open file', cx + PAD, ty, { url: m.href });
      } else {
        setText(doc, m.it.accent ? BLUE : NAVY, FS_VALUE, 'bold');
        m.lines.forEach((ln) => { doc.text(ln, cx + PAD, ty); ty += LINE_H; });
      }

      if (ci > 0) line(doc, cx, y, cx, y + rowH);
    });

    // Short final row: one rule closing off the last filled cell.
    if (measured.length < cols) {
      const cx = MARGIN + measured.length * colW;
      line(doc, cx, y, cx, y + rowH);
    }

    rpt.y = y + rowH;
  }
}

const RED = [200, 30, 45];
const GREEN = [21, 128, 61];

/**
 * Small caps label naming a table inside a stage card ("Machine Check").
 * Page-breaks with room for the table's header row plus a line, so a heading
 * never ends up stranded at the foot of a page.
 */
export function drawSubHeading(rpt, doc, text) {
  const h = 7.6;
  if (!rpt.ensure(h + 18)) line(doc, MARGIN, rpt.y, MARGIN + CONTENT_W, rpt.y);
  setText(doc, MUTED, 6.8, 'bold', 0.25);
  doc.text(String(text).toUpperCase(), MARGIN + PAD, rpt.y + 5.2);
  doc.setCharSpace(0);
  rpt.y += h;
}

/**
 * Plain column table (used for the Stage 3 inspection checklist) — same rules
 * and typography as drawFieldGrid, but a header row and fixed column widths
 * instead of label-over-value cells. `widths` are relative and scaled to the
 * content width. A "Damage" / "Good" cell is coloured; URL cells become a
 * clickable link.
 */
export function drawDataTable(rpt, doc, head, rows, widths, opts = {}) {
  // `compact` tightens type and row height for summary tables that sit above
  // the detail — they should read at a glance without dominating the page.
  const FS = opts.compact ? 7.6 : 8.2;
  const LH = opts.compact ? 3.3 : 3.6;
  const MIN_H = opts.compact ? 6.8 : 8;
  const PAD_TOP = opts.compact ? 2.6 : 3.2;
  const BASE = opts.compact ? 4.6 : 5.2;

  const scale = CONTENT_W / widths.reduce((a, b) => a + b, 0);
  const w = widths.map((x) => x * scale);
  const xs = [];
  let acc = MARGIN;
  for (const cw of w) { xs.push(acc); acc += cw; }

  const HEAD_H = opts.compact ? 6.4 : 7.2;
  const drawHead = () => {
    setText(doc, MUTED, opts.compact ? 5.5 : 5.8, 'bold', 0.18);
    head.forEach((h, i) => doc.text(String(h).toUpperCase(), xs[i] + 3, rpt.y + (opts.compact ? 4.2 : 4.7)));
    doc.setCharSpace(0);
    for (let i = 1; i < xs.length; i++) line(doc, xs[i], rpt.y, xs[i], rpt.y + HEAD_H);
    rpt.y += HEAD_H;
  };

  if (!rpt.ensure(HEAD_H + 12)) line(doc, MARGIN, rpt.y, MARGIN + CONTENT_W, rpt.y);
  drawHead();

  rows.forEach((r) => {
    setText(doc, NAVY, FS, 'normal');
    const cells = r.map((c, i) => {
      const raw = String(c ?? '');
      return isUrl(raw) ? { lines: ['Open file'], href: raw.trim() } : { lines: doc.splitTextToSize(raw, w[i] - 6), href: '' };
    });
    const rowH = Math.max(MIN_H, PAD_TOP + Math.max(...cells.map((c) => c.lines.length)) * LH + 2);

    // A row that breaks re-prints the header on the new page.
    if (rpt.ensure(rowH + HEAD_H)) drawHead();
    else line(doc, MARGIN, rpt.y, MARGIN + CONTENT_W, rpt.y);

    const y = rpt.y;
    cells.forEach((cell, i) => {
      const txt = cell.lines.join(' ');
      const status = { Damage: RED, Good: GREEN, 'Not Required': MUTED }[txt];
      let ty = y + BASE;
      if (cell.href) {
        setText(doc, BLUE, FS, 'normal');
        doc.textWithLink('Open file', xs[i] + 3, ty, { url: cell.href });
      } else {
        setText(doc, status || NAVY, FS, status ? 'bold' : 'normal');
        cell.lines.forEach((ln) => { doc.text(ln, xs[i] + 3, ty); ty += LH; });
      }
      if (i > 0) line(doc, xs[i], y, xs[i], y + rowH);
    });

    rpt.y = y + rowH;
  });
}

/** Emphasised total line closing a table — label left, amount right. */
export function drawTotalRow(rpt, doc, label, amount, opts = {}) {
  const h = opts.compact ? 8.6 : 10;
  rpt.ensure(h);
  line(doc, MARGIN, rpt.y, MARGIN + CONTENT_W, rpt.y);
  const y = rpt.y;
  setText(doc, NAVY, opts.compact ? 8.8 : 9.5, 'bold');
  const baseline = y + (opts.compact ? 5.9 : 6.8);
  doc.text(String(label), MARGIN + PAD, baseline);
  doc.text(String(amount), MARGIN + CONTENT_W - PAD, baseline, { align: 'right' });
  rpt.y = y + h;
}

/** Placeholder body for a completed stage that captured no fields. */
export function drawEmptyStageBody(rpt, doc, message) {
  const h = 11;
  rpt.ensure(h);
  line(doc, MARGIN, rpt.y, MARGIN + CONTENT_W, rpt.y);
  setText(doc, FAINT, 8, 'normal');
  doc.text(message, MARGIN + PAD, rpt.y + 7);
  rpt.y += h;
}

/** "date · <company> · Lease Management System" left, "n / N" right. */
export function stampFooters(doc, generatedAt, company) {
  const total = doc.getNumberOfPages();
  const left = [generatedAt, company, 'Lease Management System'].filter(Boolean).join(' · ');
  for (let p = 1; p <= total; p++) {
    doc.setPage(p);
    setText(doc, MUTED, 7.5, 'normal');
    doc.text(left, MARGIN, PAGE_H - 7);
    doc.text(`${p} / ${total}`, PAGE_W - MARGIN, PAGE_H - 7, { align: 'right' });
  }
}
