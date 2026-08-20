import { useState } from 'react';
import { Button } from '../../components/ui/index.js';
import styles from './ApiAccessPage.module.css';

/** Shown exactly once, right after creation — the backend never stores or
 *  returns the raw key again (apiKeys.service.js only persists its hash),
 *  same principle as a GitHub personal access token. */
export function NewKeyReveal({ keyInfo, onDone }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(keyInfo.rawKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard permission denied — the key is still selectable/copyable by hand.
    }
  };

  return (
    <div className={styles.reveal}>
      <p className={styles.revealWarn}>
        Copy this key now and share it with <b>{keyInfo.label}</b> — it will not be shown again.
        Losing it means revoking this key and creating a new one.
      </p>
      <div className={styles.revealKeyRow}>
        <code className={styles.revealKey}>{keyInfo.rawKey}</code>
        <Button type="button" variant="secondary" size="sm" onClick={handleCopy}>{copied ? 'Copied ✓' : 'Copy'}</Button>
      </div>
      <p className={styles.revealScopes}>
        Scope: {keyInfo.scopes.join(', ')}
        {keyInfo.actsAsEmail && <> — writes act as <b>{keyInfo.actsAsEmail}</b></>}
      </p>
      <div className={styles.createFooter}>
        <Button type="button" variant="primary" onClick={onDone}>Done — I've saved it</Button>
      </div>
    </div>
  );
}
