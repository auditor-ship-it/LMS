import {
  getRolesAndAccessData,
  saveEmailPermission,
  saveEmailSidebar,
  addTeamAccount,
  removeTeamAccount,
  createUserLogin
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
export async function addLogin({ name, empId, password, email }) {
  return createUserLogin({ name, empId, password, email });
}
export async function removeAccount(email) {
  return removeTeamAccount(email);
}
