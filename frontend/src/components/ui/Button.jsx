import styles from './Button.module.css';

export function Button({ variant = 'primary', size = 'md', loading, children, className, ...rest }) {
  return (
    <button
      className={`${styles.btn} ${styles[variant] || ''} ${styles[size] || ''} ${loading ? styles.loading : ''} ${className || ''}`}
      disabled={loading || rest.disabled}
      {...rest}
    >
      {children}
    </button>
  );
}
