import { useRef, useState } from 'react';
import styles from './FileUpload.module.css';

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result; // "data:<mime>;base64,<data>"
      const base64Data = String(result).split(',')[1] || '';
      resolve({ base64Data, mimeType: file.type || 'application/octet-stream', fileName: file.name });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * Reads a chosen file into { base64Data, mimeType, fileName } — the shape
 * uploadStageFile()/POST /api/uploads expects, so a caller can upload it to
 * Drive and get back a URL. Replaces manually typing a Drive URL by hand.
 */
export function FileUpload({ label = 'Choose file', onSelected, accept }) {
  const inputRef = useRef(null);
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);

  const handleChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const payload = await readFileAsBase64(file);
      setFileName(file.name);
      onSelected?.(payload);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.wrap}>
      <button type="button" className={styles.btn} onClick={() => inputRef.current?.click()} disabled={busy}>
        {busy ? 'Reading…' : label}
      </button>
      {fileName && <span className={styles.fileName}>{fileName}</span>}
      <input ref={inputRef} type="file" accept={accept} onChange={handleChange} hidden />
    </div>
  );
}
