import * as verifyService from '../services/verify.service.js';

export async function getData(req, res) {
  res.json(await verifyService.getVerifyData());
}

export async function saveAction(req, res) {
  const { timestamp, status, billingType, invoiceType, linkContainer, rowNum } = req.body;
  const message = await verifyService.saveVerifyAction(
    req.params.containerNo, timestamp, status, billingType, invoiceType, linkContainer, req.user.email, rowNum
  );
  res.json({ message });
}

export async function saveFollowUp(req, res) {
  const { timestamp, remarks, issue, rowNum } = req.body;
  const message = await verifyService.saveVerifyFollowUp(req.params.containerNo, timestamp, remarks, req.user.email, issue, rowNum);
  res.json({ message });
}

export async function editLease(req, res) {
  const { updates, rowNum } = req.body;
  const message = await verifyService.updateVerifyLeaseFields(req.params.containerNo, updates, req.user.email, rowNum);
  res.json({ message });
}

export async function saveDocument(req, res) {
  const { containerNo, docType, url, rowNum } = req.body;
  const message = await verifyService.saveVerifyDocument(containerNo, docType, url, req.user.email, rowNum);
  res.json({ message });
}

export async function uploadDocument(req, res) {
  const { base64Data, mimeType, fileName, containerNo, docType, rowNum } = req.body;
  const result = await verifyService.uploadAndSaveVerifyDocument(base64Data, mimeType, fileName, containerNo, docType, req.user.email, rowNum);
  res.json(result);
}

export async function updateLeasePeriod(req, res) {
  const { containerNo, newDateString, rowNum } = req.body;
  const message = await verifyService.updateLeasePeriod(containerNo, newDateString, req.user.email, rowNum);
  res.json({ message });
}

export async function renewWithAgreement(req, res) {
  const { containerNo, newDateString, agreementUrl, rowNum } = req.body;
  const message = await verifyService.renewLeaseWithAgreement(containerNo, newDateString, agreementUrl, req.user.email, rowNum);
  res.json({ message });
}
