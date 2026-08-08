/**
 * Outbox handlers for Verify Lease — the same "New Lease" sheet-mutation
 * logic saveVerifyAction/saveVerifyFollowUp used to run inline on the
 * request thread (under withSheetLock), now invoked asynchronously by
 * jobs/outboxWorker.js after the equivalent Mongo write has already
 * committed and been served to the client. Row lookup is still a fresh
 * live-Sheets scan by container number (never a cached row number) — the
 * only thing that moved is WHEN this runs, not how it locates the row.
 */
import { getSheetData, updateRange, updateCell, batchUpdateValues, colLetter } from '../googleSheets.service.js';
import { SHEETS } from '../../config/sheets.config.js';
import { withSheetLock } from '../../utils/sheetMutex.js';
import { safeStr } from '../../utils/format.js';
import { _padNewLeaseHeader } from '../verify.service.js';

function pad2(n) { return String(n).padStart(2, '0'); }
function dmyTime(d) {
  return `${safeStr(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

async function findRowByContainer(containerNo) {
  const { rows } = await getSheetData(SHEETS.NEW_LEASE);
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][0]) == containerNo) return { rn: i + 2, rows }; // eslint-disable-line eqeqeq
  }
  return { rn: -1, rows };
}

export async function pushSaveVerifyAction({ containerNo, timestamp, status, userEmail, billingType, invoiceType, linkContainer }) {
  return withSheetLock(SHEETS.NEW_LEASE, async () => {
    const { rn, rows } = await findRowByContainer(containerNo);
    if (rn === -1) throw new Error(`Sheets push: container not found in New Lease: ${containerNo}`);

    const { headers } = await getSheetData(SHEETS.NEW_LEASE, undefined, 'A1:1');
    let lastCol = headers.length;
    for (const r of rows) if (r.length > lastCol) lastCol = r.length;
    if (lastCol < 36) {
      const t = _padNewLeaseHeader(lastCol, 36);
      if (t.length > 0) {
        await updateRange(SHEETS.NEW_LEASE, `${colLetter(lastCol)}1:${colLetter(lastCol + t.length - 1)}1`, [t]);
      }
    }

    await batchUpdateValues([
      { range: `'${SHEETS.NEW_LEASE}'!Z${rn}:AB${rn}`, values: [[dmyTime(new Date(timestamp)), status || '', userEmail || '']] },
      { range: `'${SHEETS.NEW_LEASE}'!AH${rn}:AJ${rn}`, values: [[billingType || '', invoiceType || '', linkContainer || '']] }
    ]);
  });
}

export async function pushSaveVerifyFollowUp({ containerNo, next }) {
  return withSheetLock(SHEETS.NEW_LEASE, async () => {
    const { rn } = await findRowByContainer(containerNo);
    if (rn === -1) throw new Error(`Sheets push: container not found in New Lease: ${containerNo}`);
    await updateCell(SHEETS.NEW_LEASE, rn, 30, next);
  });
}
