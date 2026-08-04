/**
 * Outbox handlers for the roles domain — same Sheets-mutation logic
 * roles.service.js used to run inline on the request thread (updateCell/
 * appendRow/deleteRows under withSheetLock), now invoked asynchronously by
 * jobs/outboxWorker.js after the equivalent Mongo write has already
 * committed and been served to the client.
 */
import { getSheetData, updateCell, appendRow, deleteRows } from '../googleSheets.service.js';
import { SHEETS } from '../../config/sheets.config.js';
import { PERMISSION_KEYS, SIDEBAR_KEYS } from '../../config/permissions.config.js';
import { withSheetLock } from '../../utils/sheetMutex.js';
import { safeStr } from '../../utils/format.js';

async function findRowIndexByEmail(sheetName, email) {
  const { rows } = await getSheetData(sheetName);
  for (let i = 0; i < rows.length; i++) {
    if (safeStr(rows[i][0]).trim().toLowerCase() === email) return i + 2; // 1-based, +1 for header
  }
  return -1;
}

export async function pushSaveEmailPermission({ email, key, value }) {
  return withSheetLock(SHEETS.TEAM_ACCOUNTS, async () => {
    const keys = PERMISSION_KEYS.map((p) => p.key);
    const col0 = key === 'allAccess' ? 2 : 3 + keys.indexOf(key);
    const targetRow = await findRowIndexByEmail(SHEETS.TEAM_ACCOUNTS, email);
    if (targetRow === -1) throw new Error(`Sheets push: email not found in Team Accounts: ${email}`);
    await updateCell(SHEETS.TEAM_ACCOUNTS, targetRow, col0, !!value);
  });
}

export async function pushSaveEmailSidebar({ email, key, value }) {
  return withSheetLock(SHEETS.SIDEBAR_ACCESS, async () => {
    const keys = SIDEBAR_KEYS.map((p) => p.key);
    const idx = keys.indexOf(key);
    if (idx === -1) throw new Error(`Sheets push: unknown sidebar key '${key}'`);
    const targetRow = await findRowIndexByEmail(SHEETS.SIDEBAR_ACCESS, email);
    if (targetRow === -1) throw new Error(`Sheets push: email not found in Sidebar Access: ${email}`);
    await updateCell(SHEETS.SIDEBAR_ACCESS, targetRow, 1 + idx, !!value);
  });
}

export async function pushAddTeamAccount({ email, name }) {
  await withSheetLock(SHEETS.TEAM_ACCOUNTS, async () => {
    const existing = await findRowIndexByEmail(SHEETS.TEAM_ACCOUNTS, email);
    if (existing !== -1) return; // already pushed (retry after a partial failure) — don't duplicate
    const tRow = [email, name || '', false, ...PERMISSION_KEYS.map(() => false)];
    await appendRow(SHEETS.TEAM_ACCOUNTS, tRow);
  });
  await withSheetLock(SHEETS.SIDEBAR_ACCESS, async () => {
    const existing = await findRowIndexByEmail(SHEETS.SIDEBAR_ACCESS, email);
    if (existing !== -1) return;
    const sRow = [email, ...SIDEBAR_KEYS.map(() => true)];
    await appendRow(SHEETS.SIDEBAR_ACCESS, sRow);
  });
}

export async function pushRemoveTeamAccount({ email }) {
  await withSheetLock(SHEETS.TEAM_ACCOUNTS, async () => {
    const tRow = await findRowIndexByEmail(SHEETS.TEAM_ACCOUNTS, email);
    if (tRow !== -1) await deleteRows(SHEETS.TEAM_ACCOUNTS, [tRow]);
  });
  await withSheetLock(SHEETS.SIDEBAR_ACCESS, async () => {
    const sRow = await findRowIndexByEmail(SHEETS.SIDEBAR_ACCESS, email);
    if (sRow !== -1) await deleteRows(SHEETS.SIDEBAR_ACCESS, [sRow]);
  });
}
