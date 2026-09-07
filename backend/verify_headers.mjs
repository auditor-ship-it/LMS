import { connectMongo } from './src/config/db.js';
import { getExpiryDataByFilter } from './src/services/expiry.service.js';

await connectMongo();
const { headers } = await getExpiryDataByFilter('pending', null);
console.log(JSON.stringify(headers, null, 0));
process.exit(0);
