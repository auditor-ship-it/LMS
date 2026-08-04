import styles from './States.module.css';

export function LoadingState({ label = 'Loading…' }) {
  return (
    <div className={styles.wrap}>
      <div className={styles.spinner} />
      <span>{label}</span>
    </div>
  );
}
