import { Modal } from './Modal.jsx';
import styles from './LogModal.module.css';

/** Generic "activity log" popup — dates/remarks/users are parallel arrays (same index = one entry). */
export function LogModal({ open, onClose, title = 'Activity Log', dates = [], remarks = [], users = [] }) {
  const rows = dates.map((d, i) => ({ date: d, remark: remarks[i] || '', user: users[i] || '' }));
  return (
    <Modal open={open} onClose={onClose} title={title} width="520px">
      {!rows.length ? (
        <p className={styles.empty}>No log entries yet.</p>
      ) : (
        <ul className={styles.list}>
          {rows.map((r, i) => (
            <li key={i} className={styles.item}>
              <div className={styles.meta}>
                <span className={styles.date}>{r.date}</span>
                <span className={styles.user}>{r.user}</span>
              </div>
              <div className={styles.remark}>{r.remark}</div>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
