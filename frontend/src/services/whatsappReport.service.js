import {
  getWhatsappReportOverview,
  putWhatsappReportSettings,
  getWhatsappReportStatus,
  getWhatsappReportSession,
  postWhatsappReportSessionStart,
  postWhatsappReportSessionLogout,
  getWhatsappReportGroups,
  getWhatsappReportPreview,
  postWhatsappReportSendNow
} from '../api/whatsappReport.api.js';

export async function fetchWhatsappReportOverview() {
  return getWhatsappReportOverview();
}
export async function submitWhatsappReportSettings(payload) {
  return putWhatsappReportSettings(payload);
}
export async function fetchWhatsappReportStatus() {
  return getWhatsappReportStatus();
}
export async function fetchWhatsappReportSession() {
  return getWhatsappReportSession();
}
export async function startWhatsappReportSession() {
  return postWhatsappReportSessionStart();
}
export async function logoutWhatsappReportSession() {
  return postWhatsappReportSessionLogout();
}
export async function fetchWhatsappReportGroups() {
  return getWhatsappReportGroups();
}
export async function fetchWhatsappReportPreview(date) {
  return getWhatsappReportPreview(date);
}
export async function sendWhatsappReportNow() {
  return postWhatsappReportSendNow();
}
