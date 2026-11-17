import * as newLeaseQueueService from '../services/newLeaseQueue.service.js';

export async function list(req, res) {
  res.json({ data: await newLeaseQueueService.listNewLeaseQueue() });
}

export async function complete(req, res) {
  const result = await newLeaseQueueService.completeNewLeaseEntry(req.params.id, req.body, req.user?.email);
  res.json({ result });
}
