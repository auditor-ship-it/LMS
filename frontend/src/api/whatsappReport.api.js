import { apiClient } from '../shared/auth/index.js';

/** Settings + sender session overview. */
export const getWhatsappReportOverview = () => apiClient.get('/whatsapp-report').then((r) => r.data);

/** Save settings (currently just toNumbers from the modal's phone field). */
export const putWhatsappReportSettings = (payload) => apiClient.put('/whatsapp-report/settings', payload).then((r) => r.data);

/** Small status payload (enabled/connected/lastRun). */
export const getWhatsappReportStatus = () => apiClient.get('/whatsapp-report/status').then((r) => r.data);

/** Sender session (status, QR data URL while linking, connected number). */
export const getWhatsappReportSession = () => apiClient.get('/whatsapp-report/session').then((r) => r.data);

/** Starts the sender WhatsApp session (produces a QR to scan). */
export const postWhatsappReportSessionStart = () => apiClient.post('/whatsapp-report/session/start').then((r) => r.data);

/** Logs out the sender WhatsApp session. */
export const postWhatsappReportSessionLogout = () => apiClient.post('/whatsapp-report/session/logout').then((r) => r.data);

/** WhatsApp groups the sender number belongs to. */
export const getWhatsappReportGroups = () => apiClient.get('/whatsapp-report/groups').then((r) => r.data);

/** { text, imageDataUrl } preview of today's (or a given date's) report. */
export const getWhatsappReportPreview = (date) => apiClient.get('/whatsapp-report/preview', { params: date ? { date } : {} }).then((r) => r.data);

/** Sends the report immediately through the linked sender WhatsApp. */
export const postWhatsappReportSendNow = () => apiClient.post('/whatsapp-report/send-now').then((r) => r.data);
