import { connectMongo } from './src/config/db.js';
import { buildLeaseExpiryDigestGroups } from './src/services/leaseExpiryDigest.service.js';
import { emailForSalePerson } from './src/services/salePersonAccess.service.js';

await connectMongo();
const groups = await buildLeaseExpiryDigestGroups();
console.log('Salespeople with in-scope leases:', [...groups.keys()]);
for (const [name, rows] of groups) {
  console.log(`\n${name} -> ${emailForSalePerson(name) || '(no mapped email, falls back to support@)'}  (${rows.length} leases)`);
  console.log(rows.slice(0, 2));
}
process.exit(0);
