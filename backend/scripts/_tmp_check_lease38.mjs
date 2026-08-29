import 'dotenv/config';
import { connectMongo } from '../src/config/db.js';
import { getOffLeaseData, getOffLeaseDashboardData } from '../src/services/offlease.service.js';
import { getDeliveredKeys } from '../src/services/stage8.service.js';
import { getGateFormIndexSync, pickGateFormForClient, isGatedIn, isRepairNotRequired } from '../src/services/stage3Form.service.js';
import { getSheetDataFromMongo } from '../src/services/mongoSheetData.service.js';
import { safeStr } from '../src/utils/format.js';

await connectMongo();
const user = { email: 'test@test.com', role: 'admin' };

let deliveredKeys;
try { deliveredKeys = await getDeliveredKeys(); } catch (e) { deliveredKeys = undefined; }
const gateFormIndex = getGateFormIndexSync();
const sheetData = await getSheetDataFromMongo('Off-Lease Tracking');

for (const s of [6, 7, 3, 5]) {
  const d = await getOffLeaseData(s, { deliveredKeys, gateFormIndex, sheetData }, user);
  const inQueue = d.data.some(item => item.row[1] === 'LEASE0038');
  console.log(`Stage ${s}: LEASE0038 in queue = ${inQueue}`);
}

const row = sheetData.rows.find(r => safeStr(r[1]).trim() === 'LEASE0038');
const containerKey = safeStr(row[0]).toUpperCase().replace(/[^A-Z0-9]/g, '');
const gfRow = pickGateFormForClient(gateFormIndex.get(containerKey) || [], row[5]);
console.log('\nGate form match for 63Ideas Infolabs:', JSON.stringify(gfRow));
console.log('gatedIn:', isGatedIn(gfRow), '| repairSkip:', isRepairNotRequired(gfRow));

const dash = await getOffLeaseDashboardData(user);
const item = dash.items.find(it => it.leaseId === 'LEASE0038');
console.log('\nDashboard item:', JSON.stringify({ currentStage: item?.currentStage, currentStageNum: item?.currentStageNum, pendingStages: item?.pendingStages }));

process.exit(0);
