import * as authService from '../services/auth.service.js';
import { getUserAccessBundle, getUserPermissions, getUserSidebarVisibility } from '../services/permissions.service.js';
import { isRolesAdmin } from '../services/roles.service.js';

export async function login(req, res) {
  const { empId, password } = req.body;
  const result = await authService.empLogin(empId, password);
  res.json(result);
}

export async function logout(req, res) {
  const token = req.user?.token || req.body.token;
  const result = await authService.empLogout(token);
  res.json(result);
}

export async function heartbeat(req, res) {
  const ok = await authService.empHeartbeat(req.user.token);
  res.json({ ok });
}

export async function requestOtp(req, res) {
  const result = await authService.empRequestOtp(req.body.idOrEmail);
  res.json(result);
}

export async function resetPassword(req, res) {
  const { empId, otp, newPassword } = req.body;
  const result = await authService.empResetPassword(empId, otp, newPassword);
  res.json(result);
}

export async function me(req, res) {
  res.json({ empId: req.user.empId, name: req.user.name, email: req.user.email });
}

export async function accessBundle(req, res) {
  const bundle = await getUserAccessBundle(req.user.email);
  res.json(bundle);
}

export async function permissions(req, res) {
  res.json(await getUserPermissions(req.user.email));
}

export async function sidebarVisibility(req, res) {
  res.json(await getUserSidebarVisibility(req.user.email));
}

export async function loginActivity(req, res) {
  // Original getEmpLoginActivity() had no explicit permission gate of its own
  // (see the exposure note in api.js Api_Config.gs header) — restrict to
  // Roles & Access admins here since it's staff-monitoring data.
  if (!isRolesAdmin(req.user.email)) {
    return res.status(403).json({ error: 'ACCESS_DENIED: Login activity is restricted to admins.' });
  }
  res.json(await authService.getEmpLoginActivity());
}

export async function addUser(req, res) {
  if (!isRolesAdmin(req.user.email)) {
    return res.status(403).json({ error: 'ACCESS_DENIED: Restricted to admins.' });
  }
  const { name, empId, password, email } = req.body;
  const result = await authService.addUserToLogin(name, empId, password, email);
  res.json({ message: result });
}
