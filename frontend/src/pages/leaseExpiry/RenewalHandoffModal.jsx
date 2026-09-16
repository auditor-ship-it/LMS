import { useEffect, useState } from 'react';
import { Modal, Button } from '../../components/ui/index.js';
import { apiErrorMessage } from '../../shared/auth/index.js';
import { fetchCompanyContainers, requestRenewalLink } from '../../services/expiry.service.js';
import styles from './RenewalHandoffModal.module.css';

/**
 * "Renew via Sales CRM" — the Sales CRM's own renewal-entry form (Grade/Rev
 * Share/Type/LM/Client Name/Product rows/Signed-addendum-upload) works by
 * COMPANY, not container, and a single renewal PO commonly covers more than
 * one of that company's containers. This modal is the container picker that
 * bridges the two: pick which of this company's still-live containers the
 * renewal actually covers, then open the Sales CRM form pre-carrying that
 * selection (and the caller's identity) as a signed link — see
 * backend/src/services/renewalHandoff.service.js for what the link contains
 * and why containers are re-validated server-side rather than trusted from
 * here.
 *
 * `company` is the EXACT Customer Name string off the row that opened this
 * (not a free-text search) — see renewalHandoff.service.js's file header for
 * why an exact match is used here instead of the fuzzy one salesCrmLeads
 * uses for the Sale Person column.
 */
export function RenewalHandoffModal({ open, company, defaultContainer, onClose }) {
  const [loading, setLoading] = useState(false);
  const [containers, setContainers] = useState([]);
  const [selected, setSelected] = useState(() => new Set());
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open || !company) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    fetchCompanyContainers(company)
      .then((list) => {
        if (cancelled) return;
        setContainers(list);
        // Pre-check the container the user actually opened this from —
        // everything else stays unchecked, since a single renewal covering
        // several containers at once is the exception, not the default.
        setSelected(new Set(defaultContainer && list.some((c) => c.containerNo === defaultContainer) ? [defaultContainer] : []));
      })
      .catch((e) => { if (!cancelled) setError(apiErrorMessage(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, company, defaultContainer]);

  if (!open) return null;

  const toggle = (containerNo) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(containerNo)) next.delete(containerNo); else next.add(containerNo);
    return next;
  });

  const handleOpenForm = async () => {
    if (!selected.size) return;
    setOpening(true);
    setError('');
    try {
      const result = await requestRenewalLink(company, [...selected]);
      // A new tab, not a redirect — the sales rep may still have Lease
      // Expiry open behind it, mid-review of other containers.
      window.open(result.url, '_blank', 'noopener');
      onClose();
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setOpening(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={`Renew via Sales CRM — ${company}`} width="480px">
      <div className={styles.body}>
        <p className={styles.hint}>
          Select which of this company's containers this renewal covers, then open the Sales CRM's own form to fill in Grade, Rate, Type and the signed addendum.
        </p>

        {loading ? (
          <p className={styles.hint}>Loading containers…</p>
        ) : containers.length === 0 ? (
          <p className={styles.hint}>No live containers found for this company.</p>
        ) : (
          <ul className={styles.list}>
            {containers.map((c) => (
              <li key={c.containerNo} className={styles.item}>
                <label className={styles.itemLabel}>
                  <input
                    type="checkbox"
                    checked={selected.has(c.containerNo)}
                    onChange={() => toggle(c.containerNo)}
                  />
                  <span className={styles.containerNo}>{c.containerNo}</span>
                  {c.orderNo && <span className={styles.meta}>Order {c.orderNo}</span>}
                  {c.validUpto && <span className={styles.meta}>Valid {c.validUpto}</span>}
                  {typeof c.daysLeft === 'number' && (
                    <span className={styles.meta}>{c.daysLeft < 0 ? `${Math.abs(c.daysLeft)}d overdue` : `${c.daysLeft}d left`}</span>
                  )}
                </label>
              </li>
            ))}
          </ul>
        )}

        {error && <p className={styles.error}>{error}</p>}

        <div className={styles.footer}>
          <Button type="button" variant="secondary" onClick={onClose} disabled={opening}>Cancel</Button>
          <Button type="button" variant="primary" loading={opening} disabled={!selected.size} onClick={handleOpenForm}>
            Open Renewal Form{selected.size > 1 ? ` (${selected.size})` : ''}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
