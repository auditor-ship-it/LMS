import { useEffect, useRef } from 'react';
import { Icon } from './Icon.jsx';
import styles from './SearchBar.module.css';

/**
 * Search input, used by every list screen. The field itself carries no border
 * — the wrapper does — so the icon, input and clear button read as one control
 * rather than an icon sitting next to a box.
 *
 * Same props as before (value / onChange / placeholder), so every existing
 * caller keeps working untouched. `variant="large"` is the roomier, raised
 * version for a page's main search: bigger text, a soft shadow, and a "/" key
 * that jumps straight into it.
 */
export function SearchBar({ value, onChange, placeholder = 'Search…', variant }) {
  const inputRef = useRef(null);
  const large = variant === 'large';

  useEffect(() => {
    if (!large) return undefined;
    const onKey = (e) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      // Never steal the key from something being typed into.
      if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [large]);

  return (
    <div className={`${styles.wrap} ${large ? styles.large : ''}`}>
      <Icon name="search" className={styles.icon} />
      <input
        ref={inputRef}
        type="search"
        className={styles.input}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
      />
      {large && !value && <kbd className={styles.hint} aria-hidden="true">/</kbd>}
      {value && (
        <button type="button" className={styles.clear} aria-label="Clear search" onClick={() => onChange('')}>
          ×
        </button>
      )}
    </div>
  );
}
