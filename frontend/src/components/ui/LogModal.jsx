import { Modal } from './Modal.jsx';
import { formatActionTimestamp } from '../../utils/formatDateTime.js';
import styles from './LogModal.module.css';

/** Generic "activity log" popup — dates/remarks/users (and optionally issues) are parallel arrays (same index = one entry). */
export function LogModal({ open, onClose, title = 'Activity Log', dates = [], remarks = [], users = [], issues = [] }) {
  const rows = dates.map((d, i) => ({ date: d, remark: remarks[i] || '', user: users[i] || '', issue: issues[i] || '' }));
  return (
    <Modal open={open} onClose={onClose} title={title} width="520px">
      {!rows.length ? (
        <p className={styles.empty}>No log entries yet.</p>
      ) : (
        <ul className={styles.list}>
          {rows.map((r, i) => (
            <li key={i} className={styles.item}>
              <div className={styles.meta}>
                <span className={styles.date}>{formatActionTimestamp(r.date) || r.date}</span>
                <span className={styles.user}>{r.user}</span>
              </div>
              {r.issue && <span className={styles.issueTag}>{r.issue}</span>}
              <div className={styles.remark}>{r.remark}</div>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
