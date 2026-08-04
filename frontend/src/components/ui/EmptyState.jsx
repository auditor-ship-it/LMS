import { Icon } from './Icon.jsx';
import { Button } from './Button.jsx';
import styles from './States.module.css';

/** `actionLabel`/`onAction` are optional — pass both together to show the
 *  spec's single CTA button; omit for a message-only empty state. */
export function EmptyState({ message = 'No records found', hint, actionLabel, onAction }) {
  return (
    <div className={styles.emptyWrap}>
      <Icon name="inbox" size="xl" className={styles.icon} />
      <div className={styles.message}>{message}</div>
      {hint && <div className={styles.hint}>{hint}</div>}
      {actionLabel && onAction && (
        <Button size="sm" variant="primary" onClick={onAction} className={styles.retryBtn}>{actionLabel}</Button>
      )}
    </div>
  );
}
