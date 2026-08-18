import * as verifyService from '../services/verify.service.js';

export async function getData(req, res) {
  res.json(await verifyService.getVerifyData());
}

export async function saveAction(req, res) {
  const { timestamp, status, billingType, invoiceType, linkContainer } = req.body;
  const message = await verifyService.saveVerifyAction(
    req.params.containerNo, timestamp, status, billingType, invoiceType, linkContainer, req.user.email
  );
  res.json({ message });
}

export async function saveFollowUp(req, res) {
  const { timestamp, remarks, issue } = req.body;
  const message = await verifyService.saveVerifyFollowUp(req.params.containerNo, timestamp, remarks, req.user.email, issue);
  res.json({ message });
}

export async function editLease(req, res) {
  const { updates } = req.body;
  const message = await verifyService.updateVerifyLeaseFields(req.params.containerNo, updates, req.user.email);
  res.json({ message });
}

export async function saveDocument(req, res) {
  const { containerNo, docType, url } = req.body;
  const message = await verifyService.saveVerifyDocument(containerNo, docType, url, req.user.email);
  res.json({ message });
}

export async function uploadDocument(req, res) {
  const { base64Data, mimeType, fileName, containerNo, docType } = req.body;
  const result = await verifyService.uploadAndSaveVerifyDocument(base64Data, mimeType, fileName, containerNo, docType, req.user.email);
  res.json(result);
}

export async function updateLeasePeriod(req, res) {
  const { containerNo, newDateString } = req.body;
  const message = await verifyService.updateLeasePeriod(containerNo, newDateString, req.user.email);
  res.json({ message });
}

export async function renewWithAgreement(req, res) {
  const { containerNo, newDateString, agreementUrl } = req.body;
  const message = await verifyService.renewLeaseWithAgreement(containerNo, newDateString, agreementUrl, req.user.email);
  res.json({ message });
}
