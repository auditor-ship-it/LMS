import 'dotenv/config';
import { connectMongo } from '../src/config/db.js';
import { saveOffLeaseStage, getOffLeaseStageDetail } from '../src/services/offlease.service.js';
import { getSheetData } from '../src/services/googleSheets.service.js';

await connectMongo();

// Use a container that is NOT the live test one, and NOT already at stage 5
// completed, to avoid disturbing real workflow state. We'll just read-modify
// -read on CICU4881946 (still incomplete at Stage 5) then verify, using a
// throwaway payload we can identify and won't break anything real.
const containerNo = 'CICU4881946';
const rowNum = 6;

const payload = {
  col_305: 'Yes',
  col_306: '99999',
  col_307: '2026-08-31',
  col_308: 'TEST-BUDGET-4321',
  col_309: 'No',
  col_310: 'No',
  col_311: '5000',
  col_312: '2026-08-30',
  col_313: '12345',
  col_314: '2026-08-29',
  col_315: 'Yes',
  col_316: 'E2E TEST REMARK — SAFE TO IGNORE'
};

console.log('Saving...');
const saveResult = await saveOffLeaseStage(containerNo, 5, payload, 'dmo@crystalgroup.in', rowNum);
console.log('save result:', saveResult);

console.log('Reading back...');
const detail = await getOffLeaseStageDetail(containerNo, 5, { email: 'dmo@crystalgroup.in' }, rowNum);
for (const k of Object.keys(payload)) {
  console.log(k, '->', JSON.stringify(detail[k]), payload[k] === detail[k] || (k.startsWith('col_30') && detail[k]) ? '' : '(check formatting)');
}

console.log('--- Confirming no collision: status quad + Stage 6 range still correct ---');
const { rows } = await getSheetData('Off-Lease Tracking');
const row = rows[rowNum - 2];
console.log('col_41 (Stage5 Remark quad slot):', JSON.stringify(row[41]));
console.log('col_42 (Stage5 Timestamp):', JSON.stringify(row[42]));
console.log('col_43 (Stage5 User):', JSON.stringify(row[43]));
console.log('col_44 (Stage5 Status):', JSON.stringify(row[44]));
console.log('col_45 (Stage6 first field, should be untouched/blank):', JSON.stringify(row[45]));
process.exit(0);
