import axios from 'axios';

const TOKEN_KEY = 'empToken'; // same localStorage key the original Apps Script UI used

export function getStoredToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

export function setStoredToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

// Own backend, own port — no dev-proxy trick, so this works the same in a
// built production bundle as it does under `npm run dev`.
const client = axios.create({
  baseURL: import.meta.env.VITE_API_URL || 'http://localhost:4001/api'
});

client.interceptors.request.use((config) => {
  const token = getStoredToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

let onUnauthorized = null;
export function registerUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

client.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      setStoredToken('');
      if (onUnauthorized) onUnauthorized();
    }
    return Promise.reject(err);
  }
);

export default client;

/** Unwraps { error } payloads into a normal thrown Error with a clean message. */
export function apiErrorMessage(err) {
  return err?.response?.data?.error || err?.message || 'Something went wrong';
}

/**
 * Non-null only when the backend's Sheets-quota guard kicked in (either the
 * per-request rate limiter or the app-wide post-quota-error lockout — see
 * backend/src/middlewares/responseCache.middleware.js). Lets callers start a
 * matching cooldown countdown instead of just showing a generic error.
 */
export function apiQuotaRetrySeconds(err) {
  if (err?.response?.status !== 429) return null;
  const secs = err.response.data?.retryAfterSeconds;
  return typeof secs === 'number' && secs > 0 ? secs : 60;
}
