import { apiClient } from '../shared/auth/index.js';

/** GET /api/tasks/mine — same real endpoint the main app's My Task page uses. */
export const getMyTasks = () => apiClient.get('/tasks/mine').then((r) => r.data);
