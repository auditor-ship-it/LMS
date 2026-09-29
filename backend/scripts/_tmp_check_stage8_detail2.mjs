import { connectMongo } from '../src/config/db.js';
import { getOffLeaseData, getOffLeaseStageDetail } from '../src/services/offlease.service.js';

await connectMongo();

const data = await getOffLeaseData(8, {}, { email: 'aiteamcrystal@gmail.com' });
const list = data?.data || [];
console.log('Stage 8 (KAM) pending count:', list.length);

for (const item of list.slice(0, 7)) {
  const containerNo = item.row?.[0];
  const rowNum = item._rowNum;
  const start = Date.now();
  try {
    const detail = await getOffLeaseStageDetail(containerNo, 8, { email: 'aiteamcrystal@gmail.com' }, rowNum);
    console.log(`${containerNo} (row ${rowNum}): OK in ${Date.now() - start}ms`);
  } catch (e) {
    console.log(`${containerNo} (row ${rowNum}): ERROR after ${Date.now() - start}ms:`, e.message);
  }
}

process.exit(0);
