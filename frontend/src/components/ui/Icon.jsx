import styles from './Icon.module.css';

/** `<Icon name="search"/>` — outline icon from the shared sprite (see IconSprite.jsx). Inherits currentColor. */
export function Icon({ name, size, className, ...rest }) {
  const sizeClass = size ? styles[size] : '';
  return (
    <svg className={`${styles.ic} ${sizeClass} ${className || ''}`} aria-hidden="true" {...rest}>
      <use href={`#i-${name}`} />
    </svg>
  );
}
