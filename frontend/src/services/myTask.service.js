import { getMyTasks } from '../api/tasks.api.js';

export async function fetchMyTasks() {
  return getMyTasks();
}
