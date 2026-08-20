import { listApiKeys, createApiKey, revokeApiKey } from '../api/apiKeys.api.js';

export async function fetchApiKeys() {
  return listApiKeys();
}
export async function addApiKey(label, scopes, actsAsEmail) {
  return createApiKey(label, scopes, actsAsEmail);
}
export async function removeApiKey(id) {
  return revokeApiKey(id);
}
