import { useState } from 'react';
import { PageHeader, Card } from '../../components/ui/index.js';
import styles from './DriveEmbedPage.module.css';

/* Explicit request 2026-10-28 ("open to i frame"), consolidated same day
 * ("one navigation... click sop open iframe to sop and click video then
 * open iframe"): ONE sidebar entry, SOP and Video as tabs on this one page
 * rather than two separate sidebar items — each tab swaps which Drive file
 * is embedded, inline, not a new tab. Drive's normal /view URL refuses to
 * be framed (X-Frame-Options); /preview is Drive's own purpose-built embed
 * URL for exactly this. */
function toPreviewUrl(driveViewUrl) {
  return driveViewUrl.replace(/\/view(\?.*)?$/, '/preview');
}

const TABS = [
  { key: 'sop', label: 'SOP', url: 'https://drive.google.com/file/d/1pe-dvqcWy-xHTnZs7q52Y7ffw4pgdWI4/view?usp=drive_link' },
  { key: 'video', label: 'Video', url: 'https://drive.google.com/file/d/19ayTThEZTHB_7YGUIIlCtTRcc2RKObwj/view?usp=drive_link' }
];

export function OffLeaseSopPage() {
  const [tab, setTab] = useState('sop');
  const active = TABS.find((t) => t.key === tab);

  return (
    <>
      <PageHeader title="Off-Lease SOP" subtitle="Standard operating procedure" />
      <Card>
        <div className={styles.tabs}>
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              className={t.key === tab ? styles.tabActive : styles.tab}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className={styles.frameWrap}>
          <iframe
            key={active.key}
            src={toPreviewUrl(active.url)}
            title={`Off-Lease SOP — ${active.label}`}
            className={styles.frame}
            allow="autoplay"
            allowFullScreen
          />
        </div>
      </Card>
    </>
  );
}
