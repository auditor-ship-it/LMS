import * as approveService from '../services/approve.service.js';

export async function getData(req, res) {
  const doWrite = req.query.doWrite === 'true' || req.query.doWrite === '1';
  res.json(await approveService.getApproveData(doWrite));
}

export async function runAuto(req, res) {
  const message = await approveService.runAutoApproval();
  res.json({ message });
}

export async function revertAuto(req, res) {
  const message = await approveService.revertAutoApproved();
  res.json({ message });
}

export async function saveAction(req, res) {
  const { containerNo, actionType, timestamp, status } = req.body;
  const message = await approveService.saveActionData(containerNo, actionType, timestamp, status, req.user.email);
  res.json({ message });
}

export async function saveByRow(req, res) {
  const { timestamp, status } = req.body;
  const message = await approveService.saveApproveLeaseByContainer(req.params.containerNo, timestamp, status, req.user.email);
  res.json({ message });
}
