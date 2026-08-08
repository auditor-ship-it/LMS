import { apiClient } from '../shared/auth/index.js';

/** GET /api/verify — pending "New Lease" rows awaiting billing/invoice verification. */
export const getVerifyData = () => apiClient.get('/verify').then((r) => r.data);

/** POST /api/verify/:containerNo/action */
export const saveVerifyAction = (containerNo, { timestamp, status, billingType, invoiceType, linkContainer }) =>
  apiClient.post(`/verify/${encodeURIComponent(containerNo)}/action`, { timestamp, status, billingType, invoiceType, linkContainer }).then((r) => r.data);

/** POST /api/verify/:containerNo/follow-up */
export const saveVerifyFollowUp = (containerNo, { timestamp, remarks, issue }) =>
  apiClient.post(`/verify/${encodeURIComponent(containerNo)}/follow-up`, { timestamp, remarks, issue }).then((r) => r.data);

/** GET /api/verify/return-dashboard */
export const getReturnDashboardData = () => apiClient.get('/verify/return-dashboard').then((r) => r.data);

/** PUT /api/verify/:containerNo/edit — updates is a { columnIndex: value } map. */
export const editVerifyLease = (containerNo, updates) =>
  apiClient.put(`/verify/${encodeURIComponent(containerNo)}/edit`, { updates }).then((r) => r.data);

/** POST /api/verify/document/upload — uploads to Drive AND saves the URL onto the row in one call. */
export const uploadVerifyDocument = ({ base64Data, mimeType, fileName, containerNo, docType }) =>
  apiClient.post('/verify/document/upload', { base64Data, mimeType, fileName, containerNo, docType }).then((r) => r.data);
