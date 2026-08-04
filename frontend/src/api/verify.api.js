import { apiClient } from '../shared/auth/index.js';

/** GET /api/verify — pending "New Lease" rows awaiting billing/invoice verification. */
export const getVerifyData = () => apiClient.get('/verify').then((r) => r.data);

/** POST /api/verify/:containerNo/action */
export const saveVerifyAction = (containerNo, { timestamp, status, billingType, invoiceType, linkContainer }) =>
  apiClient.post(`/verify/${encodeURIComponent(containerNo)}/action`, { timestamp, status, billingType, invoiceType, linkContainer }).then((r) => r.data);

/** POST /api/verify/:containerNo/follow-up */
export const saveVerifyFollowUp = (containerNo, { timestamp, remarks }) =>
  apiClient.post(`/verify/${encodeURIComponent(containerNo)}/follow-up`, { timestamp, remarks }).then((r) => r.data);
