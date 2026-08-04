import { useState } from 'react';
import { Button } from '../../components/ui/index.js';
import styles from './RolesAccessPage.module.css';

/** New email starts with everything unchecked — tick access in the Access Grid tab afterward. */
export function AddAccountForm({ onAdd }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    const trimmedEmail = email.trim();
    if (!trimmedEmail || !trimmedEmail.includes('@')) {
      setError('Enter a valid email');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onAdd(trimmedEmail, name.trim());
      setEmail('');
      setName('');
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
      <Button type="submit" variant="primary" loading={busy}>+ Add Email</Button>
      {error && <p className={styles.addError}>{error}</p>}
    </form>
  );
}
