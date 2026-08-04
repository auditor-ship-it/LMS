import styles from './Pagination.module.css';

export function Pagination({ page, totalPages, onPrev, onNext, onPage }) {
  if (totalPages <= 1) return null;
  const pages = Array.from({ length: totalPages }, (_, i) => i + 1).filter(
    (p) => p === 1 || p === totalPages || Math.abs(p - page) <= 1
  );

  return (
    <div className={styles.wrap}>
      <button type="button" className={styles.navBtn} onClick={onPrev} disabled={page <= 1}>← Prev</button>
      <div className={styles.pages}>
        {pages.map((p, i) => (
          <span key={p}>
            {i > 0 && pages[i - 1] !== p - 1 && <span className={styles.ellipsis}>…</span>}
            <button
              type="button"
              className={`${styles.pageBtn} ${p === page ? styles.pageBtnActive : ''}`}
              onClick={() => onPage(p)}
            >
              {p}
            </button>
          </span>
        ))}
      </div>
      <button type="button" className={styles.navBtn} onClick={onNext} disabled={page >= totalPages}>Next →</button>
    </div>
  );
}
