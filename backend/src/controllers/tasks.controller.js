import * as tasksService from '../services/tasks.service.js';

export async function myTasks(req, res) {
  const force = req.query.force === 'true' || req.query.force === '1';
  res.json(await tasksService.getMyTasks(force));
}

export async function employeeTasks(req, res) {
  const force = req.query.force === 'true' || req.query.force === '1';
  const result = await tasksService.getEmployeeTasks(req.params.employeeCode, force);
  if (!result) return res.status(404).json({ error: 'Unknown employee code' });
  res.json(result);
}
