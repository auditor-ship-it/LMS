import { apiClient } from '../shared/auth/index.js';

/** GET /api/verify — pending "New Lease" rows awaiting billing/invoice verification. */
export const getVerifyData = () => apiClient.get('/verify').then((r) => r.data);

/** POST /api/verify/:containerNo/action — `rowNum` (item._rowNum from
 *  getVerifyData) addresses this exact New Lease row. Container No is not
 *  unique there (a reused container keeps its earlier row), so without it
 *  the backend falls back to matching by container number alone, which can
 *  silently write onto a different lease's row. Always pass it when known. */
export const saveVerifyAction = (containerNo, { timestamp, status, billingType, invoiceType, linkContainer, rowNum }) =>
  apiClient.post(`/verify/${encodeURIComponent(containerNo)}/action`, { timestamp, status, billingType, invoiceType, linkContainer, rowNum }).then((r) => r.data);

/** POST /api/verify/:containerNo/follow-up — `rowNum`: see saveVerifyAction's doc comment. */
export const saveVerifyFollowUp = (containerNo, { timestamp, remarks, issue, rowNum }) =>
  apiClient.post(`/verify/${encodeURIComponent(containerNo)}/follow-up`, { timestamp, remarks, issue, rowNum }).then((r) => r.data);

/** PUT /api/verify/:containerNo/edit — updates is a { columnIndex: value } map.
 *  `rowNum`: see saveVerifyAction's doc comment. */
export const editVerifyLease = (containerNo, updates, rowNum) =>
  apiClient.put(`/verify/${encodeURIComponent(containerNo)}/edit`, { updates, rowNum }).then((r) => r.data);

/** POST /api/verify/document/upload — uploads to Drive AND saves the URL onto
 *  the row in one call. `rowNum`: see saveVerifyAction's doc comment. */
export const uploadVerifyDocument = ({ base64Data, mimeType, fileName, containerNo, docType, rowNum }) =>
  apiClient.post('/verify/document/upload', { base64Data, mimeType, fileName, containerNo, docType, rowNum }).then((r) => r.data);
