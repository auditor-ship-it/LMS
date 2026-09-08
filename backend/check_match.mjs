import { connectMongo } from './src/config/db.js';
import { getSheetDataFromMongo } from './src/services/mongoSheetData.service.js';
import { SHEETS } from './src/config/sheets.config.js';
import { getGateFormForContainer } from './src/services/stage3Form.service.js';
import { refreshStage3FormCache } from './src/services/stage3Form.service.js';
import { clientMatches } from './src/services/stage8.service.js';

await connectMongo();
await refreshStage3FormCache();

const { rows } = await getSheetDataFromMongo(SHEETS.OFF_LEASE_TRACKING);
const matches = rows.filter(r => String(r[5] || '').toUpperCase().includes('ORBIT'));
for (const row of matches) {
  const containerNo = row[0];
  const clientName = row[5];
  console.log('--- Off-Lease Tracking row ---');
  console.log('Container No (exact):', JSON.stringify(containerNo));
  console.log('Client Name (exact):', JSON.stringify(clientName));
  const gf = getGateFormForContainer(containerNo, clientName);
  console.log('getGateFormForContainer result:', gf);
  if (!gf) {
    // manually check clientMatches against the two known Stage 3 rows for "SIDE CABIN"
    console.log('clientMatches("ORBITAL ", clientName):', clientMatches('ORBITAL ', clientName));
    console.log('clientMatches("ORBITATAL ", clientName):', clientMatches('ORBITATAL ', clientName));
  }
  console.log();
}
process.exit(0);
