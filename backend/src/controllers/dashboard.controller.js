import * as dashboardService from '../services/dashboard.service.js';

export async function getDeployedSummary(req, res) {
  res.json(await dashboardService.getDeployedSummaryData());
}

export async function getDeployedDetail(req, res) {
  const { month, category, type, size } = req.query;
  res.json(await dashboardService.getDeployedDetailData(month, category, type, size));
}
