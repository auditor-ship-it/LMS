import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon.jsx';
import styles from './Select.module.css';

/**
 * Custom select — design system section 14 ("Select & Menus"): a
 * `.dd-trigger` button showing the current value + a `.dd-menu` of options,
 * the selected one marked with a dot. Used instead of a native `<select>`
 * so the OPEN list gets the same styling as everything else (a native
 * select's popup is OS-chrome and can't be restyled by CSS).
 */
export function Select({ value, onChange, options, placeholder = 'Select…', ariaLabel }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const current = options.find((o) => o.value === value);

  return (
    <div className={`${styles.dropdown} ${open ? styles.open : ''}`} ref={ref}>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        {current ? current.label : placeholder}
        <Icon name="chev-down" size="sm" className={styles.caret} />
      </button>
      {open && (
        <div className={styles.menu} role="listbox">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              className={`${styles.item} ${o.value === value ? styles.itemSel : ''}`}
              onClick={() => { setOpen(false); onChange(o.value); }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
