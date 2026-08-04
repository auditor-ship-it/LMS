import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth, authApi, apiErrorMessage } from '../../shared/auth/index.js';
import { Button } from '../../components/ui/Button.jsx';
import { Icon } from '../../components/ui/Icon.jsx';
import styles from './LoginPage.module.css';

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [mode, setMode] = useState('login');
  const [empId, setEmpId] = useState('');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [otpNote, setOtpNote] = useState('');

  const handleLogin = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await login(empId, password);
      if (!res.ok) setError(res.error || 'Login failed');
      else navigate(location.state?.from || '/my-task', { replace: true });
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const handleOtpRequest = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await authApi.requestOtp(empId);
      if (!res.ok) setError(res.error || 'Could not send OTP');
      else { setOtpNote(res.note || `OTP sent to ${res.email || 'your registered email'}`); setMode('otp-reset'); }
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const handleOtpReset = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await authApi.resetPassword(empId, otp, newPassword);
      if (!res.ok) setError(res.error || 'Reset failed');
      else { setMode('login'); setPassword(''); }
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.overlay}>
      <div className={styles.card}>
        <div className={styles.brand}>
          <span className={styles.brandIcon}><Icon name="container" /></span>
          <h1>Lease Management</h1>
        </div>

        {mode === 'login' && (
          <form onSubmit={handleLogin} className={styles.form}>
            <label>Employee ID or Email</label>
            <input value={empId} onChange={(e) => setEmpId(e.target.value)} autoFocus required />
            <label>Password</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            {error && <div className={styles.error}>{error}</div>}
            <Button type="submit" size="lg" loading={loading}>Login</Button>
            <button type="button" className={styles.linkBtn} onClick={() => { setMode('otp-request'); setError(''); }}>
              Forgot password?
            </button>
          </form>
        )}

        {mode === 'otp-request' && (
          <form onSubmit={handleOtpRequest} className={styles.form}>
            <p className={styles.hint}>Enter your Employee ID or email. We'll email a 6-digit OTP.</p>
            <label>Employee ID or Email</label>
            <input value={empId} onChange={(e) => setEmpId(e.target.value)} autoFocus required />
            {error && <div className={styles.error}>{error}</div>}
            <Button type="submit" size="lg" loading={loading}>Send OTP</Button>
            <button type="button" className={styles.linkBtn} onClick={() => { setMode('login'); setError(''); }}>Back to login</button>
          </form>
        )}

        {mode === 'otp-reset' && (
          <form onSubmit={handleOtpReset} className={styles.form}>
            {otpNote && <p className={styles.hint}>{otpNote}</p>}
            <label>OTP</label>
            <input value={otp} onChange={(e) => setOtp(e.target.value)} autoFocus required maxLength={6} />
            <label>New Password</label>
            <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required minLength={4} />
            {error && <div className={styles.error}>{error}</div>}
            <Button type="submit" size="lg" loading={loading}>Reset Password</Button>
            <button type="button" className={styles.linkBtn} onClick={() => { setMode('login'); setError(''); }}>Back to login</button>
          </form>
        )}
      </div>
    </div>
  );
}
