import '../src/config/env.js';
import { connectMongo } from '../src/config/db.js';
import { getGateFormRowsForContainer, refreshStage3FormCache, pickGateFormForClient } from '../src/services/stage3Form.service.js';

await connectMongo();
await refreshStage3FormCache();
const rows = getGateFormRowsForContainer('MOAU0749105');
console.log('Row count:', rows.length);
console.log(JSON.stringify(rows.map(r => ({ status: r.status, date: r.date, customer: r.customer, location: r.location, timestamp: r.timestamp })), null, 2));
const picked = pickGateFormForClient(rows, 'SVR Medical Technologies Pvt Ltd');
console.log('Picked for SVR Medical:', JSON.stringify(picked));
process.exit(0);
