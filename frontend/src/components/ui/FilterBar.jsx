import { Select } from './Select.jsx';
import styles from './FilterBar.module.css';

/**
 * Generic filter row — `filters` is an array of
 * { key, label, options: [{value, label}], value, onChange }.
 */
export function FilterBar({ filters = [] }) {
  if (!filters.length) return null;
  return (
    <div className={styles.bar}>
      {filters.map((f) => (
        <label key={f.key} className={styles.filter}>
          <span className={styles.label}>{f.label}</span>
          <Select
            ariaLabel={f.label}
            value={f.value}
            onChange={f.onChange}
            options={[{ value: '', label: 'All' }, ...f.options]}
          />
        </label>
      ))}
    </div>
  );
}
