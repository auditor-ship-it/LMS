import { uploadFileToDrive } from '../api/upload.api.js';

export async function uploadStageFile(payload) {
  return uploadFileToDrive(payload);
}
