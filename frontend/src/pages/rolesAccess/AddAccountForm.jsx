import { useState } from 'react';
import { Button } from '../../components/ui/index.js';
import styles from './RolesAccessPage.module.css';

/**
 * New email starts with everything unchecked — tick access in the Access
 * Grid tab afterward.
 *
 * Employee ID + Password are optional (explicit request 2026-09-30: "login
 * employee id wise and employee id role and access"). Left blank, this
 * behaves exactly as before — a permissions-only row for an account that
 * logs in some other way (SSO, a shared inbox). Filled in, `onAdd` also
 * creates real login credentials (the USER sheet) for that Employee ID, so
 * a brand-new hire gets login + role/access from one form.
 */
export function AddAccountForm({ onAdd }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [empId, setEmpId] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    const trimmedEmail = email.trim();
    if (!trimmedEmail || !trimmedEmail.includes('@')) {
      setError('Enter a valid email');
      return;
    }
    const trimmedEmpId = empId.trim();
    if (trimmedEmpId && !password) {
      setError('Enter a password for this Employee ID, or leave both blank');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onAdd({ email: trimmedEmail, name: name.trim(), empId: trimmedEmpId, password });
      setEmail('');
      setName('');
      setEmpId('');
      setPassword('');
    } catch (err) {
      setError(err?.message || 'Could not add account');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className={styles.addForm} onSubmit={handleSubmit}>
      <div className={styles.addField}>
        <label className={styles.addLabel} htmlFor="raNewEmail">Email</label>
        <input
          id="raNewEmail"
          type="text"
          className={styles.addInput}
          placeholder="name@crystalgroup.in"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <div className={styles.addField}>
        <label className={styles.addLabel} htmlFor="raNewName">Name (optional)</label>
        <input
          id="raNewName"
          type="text"
          className={styles.addInput}
          placeholder="Display name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className={styles.addField}>
        <label className={styles.addLabel} htmlFor="raNewEmpId">Employee ID (optional)</label>
        <input
          id="raNewEmpId"
          type="text"
          className={styles.addInput}
          placeholder="e.g. 1234"
          value={empId}
          onChange={(e) => setEmpId(e.target.value)}
        />
      </div>
      <div className={styles.addField}>
        <label className={styles.addLabel} htmlFor="raNewPassword">Password (for login)</label>
        <input
          id="raNewPassword"
          type="text"
          className={styles.addInput}
          placeholder="Only needed with an Employee ID"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      <Button type="submit" variant="primary" loading={busy}>+ Add Email</Button>
      {error && <p className={styles.addError}>{error}</p>}
    </form>
  );
}
