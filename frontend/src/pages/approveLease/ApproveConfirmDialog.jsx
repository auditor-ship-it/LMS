import { Button, Icon } from '../../components/ui/index.js';
import styles from './ApproveConfirmDialog.module.css';

/** Confirms a Reject decision before calling decideApproval() — Approve does not need this.
 *  Carries the design system's warn-mark (error-colored alert icon in a circle) since this
 *  is always a destructive confirmation. */
export function ApproveConfirmDialog({ open, label, submitting, serverError, onCancel, onConfirm }) {
  if (!open) return null;
  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="Confirm rejection">
      <div className={styles.panel}>
        <div className={styles.head}>
          <span className={styles.warnMark}>
            <Icon name="alert" size="lg" />
          </span>
          <h2 className={styles.title}>Reject this lease?</h2>
        </div>
        <p className={styles.message}>
          Reject {label || 'this record'}? This action cannot be undone.
        </p>
        {serverError && <p className={styles.error}>{serverError}</p>}
        <div className={styles.actions}>
          <Button variant="secondary" onClick={onCancel} disabled={submitting}>Cancel</Button>
          <Button variant="danger" onClick={onConfirm} loading={submitting}>Reject</Button>
        </div>
      </div>
    </div>
  );
}
