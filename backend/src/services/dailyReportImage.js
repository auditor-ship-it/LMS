/**
 * Ported as-is from the wa-kit reference (server/services/dailyReportImage.js)
 * — a generic canvas table renderer with no Sales-OS-specific imports. Draws
 * the daily report tables into a PNG with @napi-rs/canvas (prebuilt binary,
 * no headless Chrome). Input is the { title, tables, link } object from
 * buildReportTables() in dailyWhatsappReportService.js.
 */
import { createCanvas } from '@napi-rs/canvas';

const SCALE = 2; // render at 2x so text stays sharp when zoomed on a phone
const FONT = '"DejaVu Sans", "Liberation Sans", Arial, Helvetica, sans-serif';
const PAD = 24;
const CELL_PAD_X = 12;
const ROW_H = 30;
const HEAD_H = 34;
const SECTION_GAP = 26;
const TITLE_H = 44;
const SECTION_TITLE_H = 30;
const NOTE_H = 22;

const C = {
  bg: '#ffffff',
  title: '#0f172a',
  section: '#065f46',
  headBg: '#047857',
  headText: '#ffffff',
  rowAlt: '#f1f5f9',
  text: '#1e293b',
  zero: '#94a3b8',
  border: '#cbd5e1',
  totalBg: '#d1fae5',
  note: '#64748b'
};

const font = (px, bold = false) => `${bold ? 'bold ' : ''}${px}px ${FONT}`;

/** Cells are plain values or { v, tone } — 'bad' = red (below target), 'warn' = orange. */
const cellValue = (c) => (c && typeof c === 'object' ? c.v : c);
const cellTone = (c) => (c && typeof c === 'object' ? c.tone : '');
const TONES = {
  bad: { bg: '#fee2e2', text: '#b91c1c' },
  warn: { bg: '#ffedd5', text: '#c2410c' }
};

function measureTable(ctx, t) {
  if (!t.columns.length || !t.rows.length) return { widths: [], width: 0 };
  const all = [...t.rows, ...(t.totalRow ? [t.totalRow] : [])];
  const widths = t.columns.map((col, i) => {
    ctx.font = font(13, true);
    let w = ctx.measureText(col.label).width;
    for (const r of all) {
      ctx.font = font(14, true);
      w = Math.max(w, ctx.measureText(String(cellValue(r[i]) ?? '')).width);
    }
    return Math.ceil(w + CELL_PAD_X * 2);
  });
  return { widths, width: widths.reduce((a, b) => a + b, 0) };
}

function tableHeight(t) {
  let h = SECTION_TITLE_H;
  if (!t.columns.length || !t.rows.length) return h + NOTE_H;
  h += HEAD_H + t.rows.length * ROW_H + (t.totalRow ? ROW_H : 0);
  if (t.note) h += NOTE_H + 4;
  return h;
}

export function renderReportPng(report) {
  const probe = createCanvas(10, 10).getContext('2d');
  const measured = report.tables.map((t) => measureTable(probe, t));
  probe.font = font(22, true);
  const titleW = probe.measureText(report.title).width;
  const contentW = Math.max(titleW, 420, ...measured.map((m) => m.width));
  const width = Math.ceil(contentW + PAD * 2);
  const height = Math.ceil(
    PAD + TITLE_H + report.tables.reduce((a, t) => a + tableHeight(t) + SECTION_GAP, 0) + NOTE_H + PAD
  );

  const canvas = createCanvas(width * SCALE, height * SCALE);
  const ctx = canvas.getContext('2d');
  ctx.scale(SCALE, SCALE);
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, width, height);
  ctx.textBaseline = 'middle';

  let y = PAD;
  ctx.fillStyle = C.title;
  ctx.font = font(22, true);
  ctx.textAlign = 'left';
  ctx.fillText(report.title, PAD, y + TITLE_H / 2 - 6);
  y += TITLE_H;

  report.tables.forEach((t, ti) => {
    const { widths, width: tw } = measured[ti];
    ctx.fillStyle = C.section;
    ctx.font = font(16, true);
    ctx.textAlign = 'left';
    ctx.fillText(t.title, PAD, y + SECTION_TITLE_H / 2);
    y += SECTION_TITLE_H;

    if (!t.columns.length || !t.rows.length) {
      ctx.fillStyle = C.note;
      ctx.font = font(13);
      ctx.fillText(t.note || 'No data.', PAD, y + NOTE_H / 2);
      y += NOTE_H + SECTION_GAP;
      return;
    }

    const x0 = PAD;
    const top = y;
    const drawRow = (cells, rowY, h, { bg, color, bold, sizePx }) => {
      if (bg) {
        ctx.fillStyle = bg;
        ctx.fillRect(x0, rowY, tw, h);
      }
      let x = x0;
      cells.forEach((cell, i) => {
        const col = t.columns[i];
        const v = cellValue(cell);
        const tone = TONES[cellTone(cell)];
        const s = String(v ?? '');
        if (tone) {
          ctx.fillStyle = tone.bg;
          ctx.fillRect(x, rowY, widths[i], h);
        }
        ctx.font = font(sizePx, bold || !!tone || (col.bold && color !== C.headText));
        ctx.fillStyle = tone ? tone.text : color === C.text && (v === 0 || v === '-') ? C.zero : color;
        if (col.align === 'right') {
          ctx.textAlign = 'right';
          ctx.fillText(s, x + widths[i] - CELL_PAD_X, rowY + h / 2);
        } else {
          ctx.textAlign = 'left';
          ctx.fillText(s, x + CELL_PAD_X, rowY + h / 2);
        }
        x += widths[i];
      });
    };

    drawRow(t.columns.map((c) => c.label), y, HEAD_H, { bg: C.headBg, color: C.headText, bold: true, sizePx: 13 });
    y += HEAD_H;
    t.rows.forEach((r, ri) => {
      drawRow(r, y, ROW_H, { bg: ri % 2 ? C.rowAlt : null, color: C.text, bold: false, sizePx: 14 });
      y += ROW_H;
    });
    if (t.totalRow) {
      drawRow(t.totalRow, y, ROW_H, { bg: C.totalBg, color: C.text, bold: true, sizePx: 14 });
      y += ROW_H;
    }

    // Grid
    ctx.strokeStyle = C.border;
    ctx.lineWidth = 1;
    ctx.strokeRect(x0 + 0.5, top + 0.5, tw - 1, y - top - 1);
    let x = x0;
    for (let i = 0; i < widths.length - 1; i++) {
      x += widths[i];
      ctx.beginPath();
      ctx.moveTo(x + 0.5, top);
      ctx.lineTo(x + 0.5, y);
      ctx.stroke();
    }

    if (t.note) {
      ctx.fillStyle = C.note;
      ctx.font = font(12);
      ctx.textAlign = 'left';
      ctx.fillText(t.note, PAD, y + 4 + NOTE_H / 2);
      y += NOTE_H + 4;
    }
    y += SECTION_GAP;
  });

  if (report.link) {
    ctx.fillStyle = C.note;
    ctx.font = font(12);
    ctx.textAlign = 'left';
    ctx.fillText(`Full details: ${report.link}`, PAD, y + NOTE_H / 2 - 8);
  }

  return canvas.toBuffer('image/png');
}
