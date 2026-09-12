import { connectMongo } from './src/config/db.js';
import { getSheetData } from './src/services/googleSheets.service.js';
import { SHEETS } from './src/config/sheets.config.js';

await connectMongo();
const { rows } = await getSheetData(SHEETS.OFF_LEASE_TRACKING);
const row = rows.find(r => String(r[0] || '').trim() === 'PCIU6010243');
console.log('Off-Lease Tracking row found:', !!row);
if (row) {
  console.log('Client Name (col 5):', JSON.stringify(row[5]));
  console.log('Approval status columns nearby (17-23):', row.slice(17, 24));
}

// Dry-run the Deployed lookup (read-only import, no write)
const mod = await import('./src/services/offlease.service.js');
