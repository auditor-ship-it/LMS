import { Modal } from './Modal.jsx';
import { Button } from './Button.jsx';
import { Icon } from './Icon.jsx';
import styles from './ConfirmDialog.module.css';

/** Generic confirm/cancel dialog — a destructive action names the consequence in its button label.
 *  `danger` also adds the design system's warn-mark (an error-colored alert icon in a circle)
 *  next to the message, so a destructive confirm is visually distinct from a routine one. */
export function ConfirmDialog({ open, title, message, confirmLabel = 'Confirm', danger, loading, onConfirm, onClose }) {
  return (
    <Modal open={open} onClose={onClose} title={title} width="420px">
      <div className={styles.body}>
        {danger && (
          <span className={styles.warnMark}>
            <Icon name="alert" size="lg" />
          </span>
        )}
        <p className={styles.message}>{message}</p>
      </div>
      <div className={styles.footer}>
        <Button variant="secondary" onClick={onClose} disabled={loading}>Cancel</Button>
        <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={loading}>{confirmLabel}</Button>
      </div>
    </Modal>
  );
}
