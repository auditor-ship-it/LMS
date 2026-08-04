import { apiClient } from '../shared/auth/index.js';

/**
 * POST /api/uploads — generic base64 -> Google Drive URL uploader. Same real
 * backend endpoint the main app's stage forms use for photo/document fields.
 */
export const uploadFileToDrive = ({ base64Data, mimeType, fileName }) =>
  apiClient.post('/uploads', { base64Data, mimeType, fileName }).then((r) => r.data.url);
