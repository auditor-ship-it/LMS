import styles from './SearchBar.module.css';

export function SearchBar({ value, onChange, placeholder = 'Search…' }) {
  return (
    <input
      type="text"
      className={styles.input}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      aria-label={placeholder}
    />
  );
}
