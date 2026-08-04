import styles from './Card.module.css';

export function Card({ title, actions, children, className }) {
  return (
    <div className={`${styles.card} ${className || ''}`}>
      {(title || actions) && (
        <div className={styles.header}>
          {title && <h2 className={styles.title}>{title}</h2>}
          {actions && <div className={styles.actions}>{actions}</div>}
        </div>
      )}
      <div className={styles.body}>{children}</div>
    </div>
  );
}
