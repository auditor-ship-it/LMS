import { getSyncStatus } from '../api/syncStatus.api.js';

export async function fetchSyncStatus() {
  return getSyncStatus();
}
