import { useState } from 'react';
import { Button } from '../../components/ui/index.js';
import { apiErrorMessage } from '../../shared/auth/index.js';
import styles from './ApiAccessPage.module.css';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Read implies nothing extra; Write always implies Read (a write-only key
 *  couldn't even see what it just wrote), so checking Write force-checks
 *  Read, and unchecking Read force-unchecks Write. Mirrors
 *  apiKeys.service.js's normalizeScopes exactly, one row per domain. */
function toggleRead(row) {
  const read = !row.read;
  return { read, write: read ? row.write : false };
}
function toggleWrite(row) {
  const write = !row.write;
  return { read: write ? true : row.read, write };
}

/** New key form: a label (who it's for), per-domain Read/Write scope, and —
 *  only when any Write box is checked — the real LMS user the key writes
 *  as. "All domains" is its own row: checking either box there covers every
 *  domain (including ones added later) and supersedes the individual rows,
 *  which grey out rather than double up on the same grant. */
export function CreateKeyForm({ domains, writeCapableDomains, domainLabels, onCreate, onCancel }) {
  const [label, setLabel] = useState('');
  const [actsAsEmail, setActsAsEmail] = useState('');
  const [allRow, setAllRow] = useState({ read: false, write: false });
  const [rows, setRows] = useState(() => Object.fromEntries(domains.map((d) => [d, { read: false, write: false }])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const usingAll = allRow.read || allRow.write;
  const hasAnyWrite = allRow.write || Object.values(rows).some((r) => r.write);

  const setRow = (domain, next) => setRows((prev) => ({ ...prev, [domain]: next }));

  const buildScopes = () => {
    if (allRow.write) return ['all:write'];
    if (allRow.read) return ['all'];
    const scopes = [];
    for (const d of domains) {
      const r = rows[d];
      if (r.write && writeCapableDomains.includes(d)) scopes.push(`${d}:write`);
      else if (r.read) scopes.push(d);
    }
    return scopes;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    const trimmedLabel = label.trim();
    if (!trimmedLabel) { setError('Enter a label so you know who this key is for.'); return; }
    const scopes = buildScopes();
    if (!scopes.length) { setError('Select at least one data scope.'); return; }
    const cleanActsAs = actsAsEmail.trim().toLowerCase();
    if (hasAnyWrite && !EMAIL_RE.test(cleanActsAs)) {
      setError('Write access needs a real LMS user email — writes will run with exactly that person\'s permissions.');
      return;
    }
    setBusy(true);
    try {
      await onCreate(trimmedLabel, scopes, hasAnyWrite ? cleanActsAs : undefined);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className={styles.createForm} onSubmit={handleSubmit}>
      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="akLabel">Label — who is this key for?</label>
        <input
          id="akLabel"
          className={styles.fieldInput}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. Accounts team dashboard, Partner integration…"
          autoFocus
        />
      </div>

      <div className={styles.field}>
        <span className={styles.fieldLabel}>Data this key can access</span>
        <div className={styles.scopeTable}>
          <div className={styles.scopeTableHead}>
            <span className={styles.scopeDomainHead} />
            <span>Read</span>
            <span>Write</span>
          </div>
          {domains.map((d) => {
            const canWrite = writeCapableDomains.includes(d);
            const row = rows[d];
            return (
              <div key={d} className={`${styles.scopeTableRow} ${usingAll ? styles.scopeRowDisabled : ''}`}>
                <span className={styles.scopeDomainName}>{domainLabels[d] || d}</span>
                <input
                  type="checkbox"
                  disabled={usingAll}
                  checked={usingAll ? false : row.read}
                  onChange={() => setRow(d, toggleRead(row))}
                  aria-label={`Read ${domainLabels[d] || d}`}
                />
                {canWrite ? (
                  <input
                    type="checkbox"
                    disabled={usingAll}
                    checked={usingAll ? false : row.write}
                    onChange={() => setRow(d, toggleWrite(row))}
                    aria-label={`Write ${domainLabels[d] || d}`}
                  />
                ) : (
                  <span className={styles.scopeNoWrite} title="No write endpoint exists for this domain">—</span>
                )}
              </div>
            );
          })}
          <div className={`${styles.scopeTableRow} ${styles.scopeAllRow}`}>
            <span className={styles.scopeDomainName}>{domainLabels.all}</span>
            <input
              type="checkbox"
              checked={allRow.read}
              onChange={() => setAllRow((r) => toggleRead(r))}
              aria-label="Read all domains"
            />
            <input
              type="checkbox"
              checked={allRow.write}
              onChange={() => setAllRow((r) => toggleWrite(r))}
              aria-label="Write all domains"
            />
          </div>
        </div>
        {usingAll && <p className={styles.scopeHint}>Individual rows are covered by "All domains" above and don't need their own selection.</p>}
      </div>

      {hasAnyWrite && (
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="akActsAs">Write access acts as</label>
          <input
            id="akActsAs"
            type="email"
            className={styles.fieldInput}
            value={actsAsEmail}
            onChange={(e) => setActsAsEmail(e.target.value)}
            placeholder="name@crystalgroup.in"
          />
          <p className={styles.scopeHint}>
            Every write this key makes runs with exactly this person&apos;s existing permissions and shows up in the
            app&apos;s audit trail under their name — pick someone who can already do what this key needs to do.
          </p>
        </div>
      )}

      {error && <p className={styles.createError}>{error}</p>}

      <div className={styles.createFooter}>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button type="submit" variant="primary" loading={busy}>Create key</Button>
      </div>
    </form>
  );
}
