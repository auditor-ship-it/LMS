import client from './client.js';

export const login = (empId, password) => client.post('/auth/login', { empId, password }).then((r) => r.data);
export const logout = () => client.post('/auth/logout').then((r) => r.data);
export const heartbeat = () => client.post('/auth/heartbeat').then((r) => r.data);
export const requestOtp = (idOrEmail) => client.post('/auth/otp/request', { idOrEmail }).then((r) => r.data);
export const resetPassword = (empId, otp, newPassword) => client.post('/auth/otp/reset', { empId, otp, newPassword }).then((r) => r.data);
export const me = () => client.get('/auth/me').then((r) => r.data);
export const accessBundle = () => client.get('/auth/access-bundle').then((r) => r.data);
export const loginActivity = () => client.get('/auth/login-activity').then((r) => r.data);
