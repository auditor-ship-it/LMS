import { useEffect, useMemo, useState } from 'react';
import { Button } from '../../components/ui/Button.jsx';
import { LoadingState } from '../../components/ui/LoadingState.jsx';
import { ErrorState } from '../../components/ui/ErrorState.jsx';
import { apiErrorMessage } from '../../shared/auth/index.js';
import { fetchStageDetail, fetchNextLeaseId, submitStage } from '../../services/stage.service.js';
import { uploadStageFile } from '../../services/upload.service.js';
import { useAsync } from '../../hooks/useAsync.js';
import { BASE_FIELDS, STAGE_FIELDS } from './stageFields.js';
import styles from './StageDetailModal.module.css';

/**
 * Detail/edit form for one Off-Lease row at one stage. Fields shown are
 * exactly STAGE_FIELDS[stageNumber] (never hand-written per stage — Stage 6
 * alone has 53). Pre-filled via GET /offlease/:containerNo/stage/:stage; submits
 * only the visible field keys back to POST /offlease/:containerNo/stage/:stage.
 */
export function StageDetailModal({ stageNumber, stageLabel, containerNo, readOnly, onClose, onSaved }) {
  const fields = STAGE_FIELDS[stageNumber] || [];
  const { data, loading, error, reload } = useAsync(() => fetchStageDetail(containerNo, stageNumber), [containerNo, stageNumber]);
  const { data: leaseIdPreview } = useAsync(
    () => (stageNumber === 1 ? fetchNextLeaseId() : Promise.resolve(null)),
    [stageNumber]
  );

  const [values, setValues] = useState({});
  const [pendingFiles, setPendingFiles] = useState({});
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [saveError, setSaveError] = useState('');

  useEffect(() => {
    if (data) setValues(data);
  }, [data]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const setField = (key, v) => setValues((prev) => ({ ...prev, [key]: v }));

  const visibleFields = useMemo(() => fields.filter((f) => !f.showIf || f.showIf(values)), [fields, values]);

  const busy = saving || uploading;

  async function handleSubmit(e) {
    e.preventDefault();
    if (readOnly) return;
    setSaveError('');

    for (const f of visibleFields) {
      if (!f.required) continue;
      const hasValue = f.type === 'file' ? (values[f.key] || pendingFiles[f.key]) : String(values[f.key] ?? '').trim();
      if (!hasValue) {
        setSaveError(`"${f.label}" is required`);
        return;
      }
    }

    let finalValues = values;
    const fileKeys = Object.keys(pendingFiles);
    if (fileKeys.length) {
      setUploading(true);
      try {
        const uploaded = {};
        for (const key of fileKeys) uploaded[key] = await uploadStageFile(pendingFiles[key]);
        finalValues = { ...values, ...uploaded };
        setValues(finalValues);
        setPendingFiles({});
      } catch {
        setSaveError('File upload failed — save aborted');
        setUploading(false);
        return;
      }
      setUploading(false);
    }

    const payload = {};
    for (const f of visibleFields) {
      const v = finalValues[f.key];
      if (v !== '' && v != null) payload[f.key] = v;
    }

    setSaving(true);
    try {
      const message = await submitStage(containerNo, stageNumber, payload);
      if (message === 'ALREADY_PROCESSED') {
        setSaveError('This record was already processed by someone else — refreshing…');
        reload();
      } else {
        onSaved();
      }
    } catch (err) {
      setSaveError(apiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={styles.backdrop} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={styles.modal} role="dialog" aria-modal="true" aria-label={`Stage ${stageNumber} — ${stageLabel}`}>
        <div className={styles.header}>
          <h2 className={styles.title}>Stage {stageNumber} — {stageLabel}</h2>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className={styles.body}>
          {loading && <LoadingState />}
          {!loading && error && <ErrorState message={error} onRetry={reload} />}
          {!loading && !error && (
            <form onSubmit={handleSubmit}>
              <div className={styles.baseGrid}>
                {BASE_FIELDS.map((f) => (
                  <div key={f.key} className={styles.baseItem}>
                    <span className={styles.baseLabel}>{f.label}</span>
                    <span className={styles.baseValue}>
                      {f.key === 'col_1' && !data?.[f.key] && leaseIdPreview
                        ? `${leaseIdPreview} (auto)`
                        : (data?.[f.key] || '—')}
                    </span>
                  </div>
                ))}
              </div>

              <div className={styles.fieldGrid}>
                {visibleFields.map((f) => (
                  <Field
                    key={f.key}
                    field={f}
                    value={values[f.key]}
                    pendingFileName={pendingFiles[f.key]?.fileName}
                    onChange={(v) => setField(f.key, v)}
                    onFile={(payload) => { setPendingFiles((p) => ({ ...p, [f.key]: payload })); setField(f.key, payload.fileName); }}
                    disabled={readOnly || busy}
                  />
                ))}
              </div>

              {saveError && <div className={styles.error}>{saveError}</div>}

              <div className={styles.actions}>
                <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
                  {readOnly ? 'Close' : 'Cancel'}
                </Button>
                {!readOnly && (
                  <Button type="submit" variant="primary" loading={busy}>
                    {uploading ? 'Uploading files…' : saving ? 'Saving…' : 'Save Stage'}
                  </Button>
                )}
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ field, value, pendingFileName, onChange, onFile, disabled }) {
  const { label, type, options = [], required } = field;

  if (type === 'text') {
    return (
      <Labeled label={label} required={required}>
        <input type="text" value={value || ''} onChange={(e) => onChange(e.target.value)} disabled={disabled} />
      </Labeled>
    );
  }
  if (type === 'textarea') {
    return (
      <Labeled label={label} required={required} full>
        <textarea rows={3} value={value || ''} onChange={(e) => onChange(e.target.value)} disabled={disabled} />
      </Labeled>
    );
  }
  if (type === 'number') {
    return (
      <Labeled label={label} required={required}>
        <input type="number" step="any" value={value || ''} onChange={(e) => onChange(e.target.value)} disabled={disabled} />
      </Labeled>
    );
  }
  if (type === 'date') {
    return (
      <Labeled label={label} required={required}>
        <input type="date" value={value || ''} onChange={(e) => onChange(e.target.value)} disabled={disabled} />
      </Labeled>
    );
  }
  if (type === 'datetime') {
    return (
      <Labeled label={label} required={required}>
        <input type="datetime-local" value={value || ''} onChange={(e) => onChange(e.target.value)} disabled={disabled} />
      </Labeled>
    );
  }
  if (type === 'select') {
    return (
      <Labeled label={label} required={required}>
        <select value={value || ''} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
          <option value="">Select…</option>
          {options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      </Labeled>
    );
  }
  if (type === 'selectOther') {
    return (
      <Labeled label={label} required={required}>
        <SelectOtherInput options={options} value={value} onChange={onChange} disabled={disabled} />
      </Labeled>
    );
  }
  if (type === 'radio') {
    return (
      <Labeled label={label} required={required}>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          {options.map((o) => (
            <label key={o} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 13, fontWeight: 500 }}>
              <input
                type="radio"
                name={field.key}
                value={o}
                checked={value === o}
                onChange={() => onChange(o)}
                disabled={disabled}
              />
              {o}
            </label>
          ))}
        </div>
      </Labeled>
    );
  }
  if (type === 'file') {
    return (
      <Labeled label={label} required={required}>
        <FileFieldInput value={value} pendingFileName={pendingFileName} onFile={onFile} disabled={disabled} />
      </Labeled>
    );
  }
  return null;
}

function FileFieldInput({ value, pendingFileName, onFile, disabled }) {
  const [busy, setBusy] = useState(false);

  const handleChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const base64Data = await readFileAsBase64(file);
      onFile({ base64Data, mimeType: file.type || 'application/octet-stream', fileName: file.name });
    } finally {
      setBusy(false);
      e.target.value = '';
    }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      {value && /^https?:\/\//.test(value) && (
        <a href={value} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: 'var(--blue-600)' }}>View current file</a>
      )}
      {pendingFileName && <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{pendingFileName} (pending upload)</span>}
      {!disabled && (
        <label style={{ fontSize: 12, cursor: 'pointer', color: 'var(--blue-600)', fontWeight: 700 }}>
          {busy ? 'Reading…' : value ? 'Replace file' : 'Choose file'}
          <input type="file" onChange={handleChange} disabled={busy} hidden />
        </label>
      )}
    </div>
  );
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/** Select-with-free-text-Other, used by Stage 6's Size/Container Type/Quantity fields. */
function SelectOtherInput({ options, value, onChange, disabled }) {
  const [otherMode, setOtherMode] = useState(() => !!value && !options.includes(value));

  useEffect(() => {
    if (value && !options.includes(value)) setOtherMode(true);
  }, [value, options]);

  const handleSelect = (e) => {
    const v = e.target.value;
    if (v === 'Other') {
      setOtherMode(true);
      onChange('');
    } else {
      setOtherMode(false);
      onChange(v);
    }
  };

  return (
    <>
      <select value={otherMode ? 'Other' : (value || '')} onChange={handleSelect} disabled={disabled}>
        <option value="">Select…</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
        <option value="Other">Other</option>
      </select>
      {otherMode && (
        <input
          type="text"
          placeholder="Specify…"
          style={{ marginTop: 6 }}
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
        />
      )}
    </>
  );
}

function Labeled({ label, required, full, children }) {
  return (
    <label className={`${styles.field} ${full ? styles.full : ''}`}>
      <span className={styles.label}>{label}{required && <span className={styles.req}> *</span>}</span>
      {children}
    </label>
  );
}
