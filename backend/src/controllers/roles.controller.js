import * as rolesService from '../services/roles.service.js';

export async function getData(req, res) {
  res.json(await rolesService.getRolesAndAccessData(req.user.email));
}

export async function savePermission(req, res) {
  const { email, key, value } = req.body;
  res.json({ message: await rolesService.saveEmailPermission(req.user.email, email, key, value) });
}

export async function saveSidebar(req, res) {
  const { email, key, value } = req.body;
  res.json({ message: await rolesService.saveEmailSidebar(req.user.email, email, key, value) });
}

export async function addAccount(req, res) {
  const { email, name } = req.body;
  res.json({ message: await rolesService.addTeamAccount(req.user.email, email, name) });
}

export async function removeAccount(req, res) {
  const { email } = req.body;
  res.json({ message: await rolesService.removeTeamAccount(req.user.email, email) });
}
