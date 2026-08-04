import { Icon } from './Icon.jsx';
import { Button } from './Button.jsx';
import styles from './States.module.css';

export function ErrorState({ message, onRetry }) {
  return (
    <div className={styles.wrap}>
      <Icon name="alert" size="lg" className={styles.errorIcon} />
      <div className={`${styles.message} ${styles.errorMessage}`}>{message}</div>
      {onRetry && <Button size="sm" variant="primary" onClick={onRetry} className={styles.retryBtn}>Retry</Button>}
    </div>
  );
}
