import {
  getRolesAndAccessData,
  saveEmailPermission,
  saveEmailSidebar,
  addTeamAccount,
  removeTeamAccount
} from '../api/roles.api.js';

export async function fetchRolesAndAccess() {
  return getRolesAndAccessData();
}
export async function setEmailPermission(email, key, value) {
  return saveEmailPermission(email, key, value);
}
export async function setEmailSidebar(email, key, value) {
  return saveEmailSidebar(email, key, value);
}
export async function addAccount(email, name) {
  return addTeamAccount(email, name);
}
export async function removeAccount(email) {
  return removeTeamAccount(email);
}
