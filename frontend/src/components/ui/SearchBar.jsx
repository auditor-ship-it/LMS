import { Icon } from './Icon.jsx';
import styles from './SearchBar.module.css';

/**
 * Search input, used by every list screen. The field itself carries no border
 * — the wrapper does — so the icon, input and clear button read as one control
 * rather than an icon sitting next to a box.
 *
 * Same props as before (value / onChange / placeholder), so every existing
 * caller keeps working untouched.
 */
export function SearchBar({ value, onChange, placeholder = 'Search…' }) {
  return (
    <div className={styles.wrap}>
      <Icon name="search" className={styles.icon} />
      <input
        type="search"
        className={styles.input}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
      />
      {value && (
        <button type="button" className={styles.clear} aria-label="Clear search" onClick={() => onChange('')}>
          ×
        </button>
      )}
    </div>
  );
}
