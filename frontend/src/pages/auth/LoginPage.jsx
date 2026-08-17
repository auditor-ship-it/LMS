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
  const [showPw, setShowPw] = useState(false);

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

  /* Errors are announced, not just coloured: the sign-in failure is the one
     message on this page a user must not miss. */
  const errorBlock = error && (
    <div className={styles.error} role="alert">
      <Icon name="alert" />
      <span>{error}</span>
    </div>
  );

  const brandMark = (
    <span className={styles.mark}><Icon name="container" /></span>
  );

  const backToLogin = (
    <div className={styles.backRow}>
      <Icon name="chev-left" />
      <button
        type="button"
        className={styles.linkBtn}
        onClick={() => { setMode('login'); setError(''); }}
      >
        Back to login
      </button>
    </div>
  );

  return (
    <div className={styles.shell}>
      {/* Brand panel. Purely decorative for screen readers — every word here
          is repeated by the form side's heading or the app itself. */}
      <aside className={styles.side} aria-hidden="true">
        <div className={styles.sideInner}>
          <div className={styles.lockup}>
            {brandMark}
            <span className={styles.lockupText}>
              <span className={styles.lockupName}>Lease Management</span>
              <span className={styles.lockupOrg}>Crystal Group</span>
            </span>
          </div>
        </div>

        <div className={styles.sideInner}>
          <h2 className={styles.headline}>Every container, <em>every stage</em>.</h2>
          <p className={styles.sub}>
            Lease, renewal and off-lease movement tracked end to end — from intimation
            through inspection, billing and FMS closure.
          </p>
          <div className={styles.points}>
            <div className={styles.point}>
              <span className={styles.pointIcon}><Icon name="container" /></span>
              Lease, renewal and off-lease workflow
            </div>
            <div className={styles.point}>
              <span className={styles.pointIcon}><Icon name="clock" /></span>
              Stage-wise SLA and TAT tracking
            </div>
            <div className={styles.point}>
              <span className={styles.pointIcon}><Icon name="check-circle" /></span>
              Approvals, billing and outstanding
            </div>
          </div>
        </div>

        <div className={styles.sideFoot}>Crystal Group · Internal use only</div>
      </aside>

      <main className={styles.pane}>
        <div className={styles.form}>
          <div className={styles.paneBrand}>
            {brandMark}
            <span className={styles.lockupText}>
              <span className={styles.lockupName} style={{ color: 'var(--text)' }}>Lease Management</span>
              <span className={styles.lockupOrg} style={{ color: 'var(--text-3)' }}>Crystal Group</span>
            </span>
          </div>

          {mode === 'login' && (
            <form onSubmit={handleLogin}>
              <h1 className={styles.title}>Sign in</h1>
              <p className={styles.lede}>Use your Crystal employee ID or work email.</p>

              {errorBlock}

              <div className={styles.field}>
                <label className={styles.label} htmlFor="lg-id">Employee ID or Email</label>
                <input
                  id="lg-id"
                  className={styles.input}
                  value={empId}
                  onChange={(e) => setEmpId(e.target.value)}
                  placeholder="e.g. 1962 or name@crystalgroup.in"
                  autoComplete="username"
                  autoFocus
                  required
                />
              </div>

              <div className={styles.field}>
                <div className={styles.labelRow}>
                  <label className={styles.label} htmlFor="lg-pw">Password</label>
                  <button
                    type="button"
                    className={styles.linkBtn}
                    onClick={() => { setMode('otp-request'); setError(''); }}
                  >
                    Forgot password?
                  </button>
                </div>
                <div className={styles.pwWrap}>
                  <input
                    id="lg-pw"
                    className={styles.input}
                    type={showPw ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                    required
                  />
                  <button
                    type="button"
                    className={`${styles.pwToggle} ${showPw ? '' : styles.pwOff}`}
                    onClick={() => setShowPw((v) => !v)}
                    aria-label={showPw ? 'Hide password' : 'Show password'}
                    tabIndex={-1}
                  >
                    <Icon name="eye" />
                  </button>
                </div>
              </div>

              <Button type="submit" size="lg" loading={loading} className={styles.submit}>Login</Button>
            </form>
          )}

          {mode === 'otp-request' && (
            <form onSubmit={handleOtpRequest}>
              <h1 className={styles.title}>Reset password</h1>
              <p className={styles.lede}>
                Enter your Employee ID or email and we&apos;ll send a 6-digit OTP to your
                registered address.
              </p>

              {errorBlock}

              <div className={styles.field}>
                <label className={styles.label} htmlFor="rq-id">Employee ID or Email</label>
                <input
                  id="rq-id"
                  className={styles.input}
                  value={empId}
                  onChange={(e) => setEmpId(e.target.value)}
                  autoComplete="username"
                  autoFocus
                  required
                />
              </div>

              <Button type="submit" size="lg" loading={loading} className={styles.submit}>Send OTP</Button>
              {backToLogin}
            </form>
          )}

          {mode === 'otp-reset' && (
            <form onSubmit={handleOtpReset}>
              <h1 className={styles.title}>Enter OTP</h1>
              {otpNote && <p className={styles.hint}>{otpNote}</p>}

              {errorBlock}

              <div className={styles.field}>
                <label className={styles.label} htmlFor="rs-otp">6-digit OTP</label>
                <input
                  id="rs-otp"
                  className={`${styles.input} ${styles.otpInput}`}
                  value={otp}
                  onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="000000"
                  autoFocus
                  required
                  maxLength={6}
                />
              </div>

              <div className={styles.field}>
                <label className={styles.label} htmlFor="rs-pw">New Password</label>
                <div className={styles.pwWrap}>
                  <input
                    id="rs-pw"
                    className={styles.input}
                    type={showPw ? 'text' : 'password'}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    autoComplete="new-password"
                    required
                    minLength={4}
                  />
                  <button
                    type="button"
                    className={`${styles.pwToggle} ${showPw ? '' : styles.pwOff}`}
                    onClick={() => setShowPw((v) => !v)}
                    aria-label={showPw ? 'Hide password' : 'Show password'}
                    tabIndex={-1}
                  >
                    <Icon name="eye" />
                  </button>
                </div>
              </div>

              <Button type="submit" size="lg" loading={loading} className={styles.submit}>Reset Password</Button>
              {backToLogin}
            </form>
          )}
        </div>
      </main>
    </div>
  );
}
