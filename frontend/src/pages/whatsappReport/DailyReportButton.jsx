import { useEffect, useState } from 'react';
import { Modal } from '../../components/ui/Modal.jsx';
import { Button } from '../../components/ui/index.js';
import { apiErrorMessage } from '../../shared/auth/index.js';
import { useAsync } from '../../hooks/useAsync.js';
import { usePolling } from '../../hooks/usePolling.js';
import {
  fetchWhatsappReportOverview,
  fetchWhatsappReportSession,
  startWhatsappReportSession,
  submitWhatsappReportSettings,
  fetchWhatsappReportPreview,
  sendWhatsappReportNow
} from '../../services/whatsappReport.service.js';
import styles from './DailyReportButton.module.css';

const DEFAULT_NUMBER = '919321774772';

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Admin-only "Daily WhatsApp Report" header button. Opens a small pop-up with
 * the sender WhatsApp's QR/connection status, a phone number field
 * (defaulting to the India number 919321774772), a preview of the Sale
 * Person — Contract Expiry Summary report image, and a Send now button.
 *
 * Deliberately minimal — per the implementation task, the kit's own fuller
 * settings UI (groups, multiple schedule times, team targets) is NOT ported
 * here; the backend supports it for later, this modal only needs connect +
 * number + preview + send.
 */
function DailyReportModalBody({ onClose }) {
  const overview = useAsync(fetchWhatsappReportOverview, []);
  const [session, setSession] = useState(null);
  const [number, setNumber] = useState(DEFAULT_NUMBER);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(''); // '' | 'connect' | 'preview' | 'send'
  const [notice, setNotice] = useState(null); // { kind: 'ok' | 'err', text }

  useEffect(() => {
    if (overview.data?.session) setSession(overview.data.session);
    if (overview.data?.settings?.toNumbers?.length) setNumber(overview.data.settings.toNumbers[0]);
  }, [overview.data]);

  const connected = !!session?.connected;

  const refreshSession = async () => {
    try {
      const s = await fetchWhatsappReportSession();
      setSession(s);
    } catch {
      /* next poll retries */
    }
  };

  // While not connected, keep polling so a freshly-produced QR (and the
  // "Connected" state right after a scan) show up without a manual reload.
  usePolling(refreshSession, 3000, !connected);

  const connect = async () => {
    setBusy('connect');
    setNotice(null);
    try {
      const s = await startWhatsappReportSession();
      setSession(s);
    } catch (e) {
      setNotice({ kind: 'err', text: apiErrorMessage(e) });
    } finally {
      setBusy('');
    }
  };

  const loadPreview = async () => {
    setBusy('preview');
    setNotice(null);
    try {
      const r = await fetchWhatsappReportPreview(todayStr());
      setPreview(r);
    } catch (e) {
      setNotice({ kind: 'err', text: apiErrorMessage(e) });
    } finally {
      setBusy('');
    }
  };

  useEffect(() => {
    void loadPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sendNow = async () => {
    setBusy('send');
    setNotice(null);
    try {
      await submitWhatsappReportSettings({ toNumbers: [number] });
      const r = await sendWhatsappReportNow();
      setNotice({ kind: 'ok', text: r.message || 'Report sent.' });
    } catch (e) {
      setNotice({ kind: 'err', text: apiErrorMessage(e) });
    } finally {
      setBusy('');
    }
  };

  return (
    <div>
      <div className={styles.statusLine}>
        <span className={`${styles.dot} ${connected ? styles.dotOk : ''}`} />
        {connected
          ? <span>Connected as +{session.connectedNumber}</span>
          : <span>Not connected</span>}
      </div>

      {notice && (
        <div className={`${styles.notice} ${notice.kind === 'ok' ? styles.noticeOk : styles.noticeErr}`}>
          {notice.text}
        </div>
      )}

      {!connected && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Connect WhatsApp</div>
          <div className={styles.qrWrap}>
            {session?.qrDataUrl ? (
              <img src={session.qrDataUrl} alt="WhatsApp QR code" className={styles.qrImg} />
            ) : (
              <p className={styles.muted}>
                {session?.status === 'initializing' ? (session.progressMessage || 'Starting WhatsApp...') : 'Click Connect to get a QR code.'}
              </p>
            )}
            {session?.lastError && <p className={styles.muted}>{session.lastError}</p>}
            <Button type="button" variant="primary" size="sm" onClick={connect} loading={busy === 'connect'}>
              {session?.qrDataUrl ? 'Get a fresh QR' : 'Connect'}
            </Button>
          </div>
        </div>
      )}

      <div className={styles.field}>
        <label htmlFor="wa-report-number">Phone number (with country code)</label>
        <input id="wa-report-number" type="text" value={number} onChange={(e) => setNumber(e.target.value)} placeholder={DEFAULT_NUMBER} />
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Preview — Sale Person Contract Expiry Summary</div>
        <div className={styles.actionsRow}>
          <Button type="button" variant="secondary" size="sm" onClick={loadPreview} loading={busy === 'preview'}>
            Refresh preview
          </Button>
        </div>
        {preview?.imageDataUrl
          ? <img src={preview.imageDataUrl} alt="Report preview" className={styles.previewImg} />
          : <p className={styles.muted}>No preview yet.</p>}
      </div>

      <div className={styles.actionsRow}>
        <Button type="button" variant="secondary" size="sm" onClick={onClose} disabled={busy === 'send'}>Close</Button>
        <Button type="button" variant="primary" size="sm" onClick={sendNow} loading={busy === 'send'} disabled={!connected}>
          Send now
        </Button>
      </div>
      {!connected && <p className={styles.muted}>Connect WhatsApp before sending.</p>}
    </div>
  );
}

export function DailyReportButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)}>
        Daily WhatsApp Report
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Daily WhatsApp Report" width="560px">
        {open && <DailyReportModalBody onClose={() => setOpen(false)} />}
      </Modal>
    </>
  );
}
