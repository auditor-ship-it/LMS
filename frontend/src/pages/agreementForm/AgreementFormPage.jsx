import { useMemo, useState } from 'react';
import { PageHeader, Card, Button, SearchBar, LoadingState, ErrorState, EmptyState, renderCellValue } from '../../components/ui/index.js';
import { useAsync } from '../../hooks/useAsync.js';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import { usePermission } from '../../hooks/usePermission.js';
import { apiErrorMessage } from '../../shared/auth/index.js';
import { fetchVerifyList, submitAgreementEdit, uploadAgreementDocument } from '../../services/verify.service.js';
import { visibleColumnIndices, rowMatchesSearch } from '../../utils/tableFilters.js';
import styles from './AgreementFormPage.module.css';

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * Agreement Form — search any pending lease, view every field, edit and
 * submit corrections in place (backed by PUT /verify/:containerNo/edit),
 * and replace the PO / Agreement PDF. The record was never removed from
 * the Verify Lease pending list by a Send Back, so once corrected here it's
 * simply ready to be verified — no separate "resubmit" step is needed.
 */
export function AgreementFormPage() {
  const { canAct } = usePermission();
  const canEdit = canAct('verify');

  const { data, loading, error, reload } = useAsync(fetchVerifyList, []);
  const headers = data?.headers || [];
  const items = data?.data || [];

  const [search, setSearch] = useState('');
  const [selectedRowNum, setSelectedRowNum] = useState(null);
  const debouncedSearch = useDebouncedValue(search, 200);

  const visibleColIdx = useMemo(() => visibleColumnIndices(headers), [headers]);
  const filtered = useMemo(() => items.filter((it) => rowMatchesSearch(it.row, debouncedSearch)), [items, debouncedSearch]);
  const selected = selectedRowNum != null ? items.find((it) => it._rowNum === selectedRowNum) : null;

  return (
    <>
      <PageHeader title="Agreement Form" subtitle="Search a lease, view and edit all its data, and update PO / Agreement files" />
      {!canEdit && (
        <div className={styles.viewOnlyBanner}>View Only — you don&apos;t have permission to edit lease data.</div>
      )}
      <Card>
        {!selected ? (
          <>
            <SearchBar value={search} onChange={setSearch} placeholder="Search by container, client, order no…" />
            <p className={styles.hint}>{filtered.length} of {items.length} pending lease{items.length === 1 ? '' : 's'} · click a row to open</p>
            {loading && <LoadingState />}
            {!loading && error && <ErrorState message={error} onRetry={reload} />}
            {!loading && !error && !filtered.length && <EmptyState message="No matching leases" />}
            {!loading && !error && !!filtered.length && (
              <div className={styles.list}>
                {filtered.slice(0, 50).map((it) => (
                  <button key={it._rowNum} type="button" className={styles.listItem} onClick={() => setSelectedRowNum(it._rowNum)}>
                    <span className={styles.listContainer}>{it.row[0]}</span>
                    <span className={styles.listMeta}>{it.row[1]} · {it.row[2]}</span>
                  </button>
                ))}
                {filtered.length > 50 && <p className={styles.hint}>Showing first 50 — refine your search to narrow further.</p>}
              </div>
            )}
          </>
        ) : (
          <AgreementEditForm
            item={selected}
            headers={headers}
            visibleColIdx={visibleColIdx}
            canEdit={canEdit}
            onBack={() => setSelectedRowNum(null)}
            onSaved={() => { setSelectedRowNum(null); reload(); }}
          />
        )}
      </Card>
    </>
  );
}

function AgreementEditForm({ item, headers, visibleColIdx, canEdit, onBack, onSaved }) {
  const initial = useMemo(() => {
    const o = {};
    for (const ci of visibleColIdx) if (ci !== 0) o[ci] = item.row[ci] ?? '';
    return o;
  }, [item, visibleColIdx]);

  const [values, setValues] = useState(initial);
  const [poFile, setPoFile] = useState(null);
  const [agrFile, setAgrFile] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  const setField = (ci, v) => setValues((prev) => ({ ...prev, [ci]: v }));

  async function pickFile(e, setter) {
    const file = e.target.files?.[0];
    if (!file) return;
    const base64Data = await readFileAsBase64(file);
    setter({ base64Data, mimeType: file.type || 'application/octet-stream', fileName: file.name });
    e.target.value = '';
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!canEdit) return;
    setSaveError('');
    setSaving(true);
    try {
      if (poFile) await uploadAgreementDocument({ ...poFile, containerNo: item.row[0], docType: 'po' });
      if (agrFile) await uploadAgreementDocument({ ...agrFile, containerNo: item.row[0], docType: 'agreement' });

      const updates = {};
      for (const ci of visibleColIdx) {
        if (ci === 0) continue;
        const orig = String(item.row[ci] ?? '');
        const next = String(values[ci] ?? '');
        if (orig !== next) updates[ci] = next;
      }
      if (Object.keys(updates).length) await submitAgreementEdit(item.row[0], updates);

      onSaved();
    } catch (err) {
      setSaveError(apiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <Button type="button" variant="secondary" size="sm" onClick={onBack} className={styles.backBtn}>← Back to Search</Button>

      <div className={styles.detailCard}>
        <div className={styles.detailHeader}>
          <h4 className={styles.detailTitle}>{item.row[0]}</h4>
        </div>

        <div className={styles.fieldGrid}>
          {visibleColIdx.map((ci) => (
            ci === 0 ? (
              <div key={ci} className={styles.field}>
                <span className={styles.label}>{headers[ci] || `Column ${ci + 1}`}</span>
                <span className={styles.readonlyValue}>{renderCellValue(item.row[ci])}</span>
              </div>
            ) : (
              <label key={ci} className={styles.field}>
                <span className={styles.label}>{headers[ci] || `Column ${ci + 1}`}</span>
                <input
                  type="text"
                  value={values[ci] ?? ''}
                  onChange={(e) => setField(ci, e.target.value)}
                  disabled={!canEdit || saving}
                />
              </label>
            )
          ))}
        </div>

        <div className={styles.fileGrid}>
          <FileField label="PO PDF" currentUrl={item.poUrl} pendingFile={poFile} onPick={(e) => pickFile(e, setPoFile)} disabled={!canEdit || saving} />
          <FileField label="Agreement PDF" currentUrl={item.agrUrl} pendingFile={agrFile} onPick={(e) => pickFile(e, setAgrFile)} disabled={!canEdit || saving} />
        </div>

        {saveError && <div className={styles.error}>{saveError}</div>}

        <div className={styles.detailFooter}>
          <Button type="button" variant="secondary" onClick={onBack} disabled={saving}>Cancel</Button>
          {canEdit && <Button type="submit" variant="primary" loading={saving}>{saving ? 'Saving…' : 'Submit'}</Button>}
        </div>
      </div>
    </form>
  );
}

function FileField({ label, currentUrl, pendingFile, onPick, disabled }) {
  return (
    <div className={styles.field}>
      <span className={styles.label}>{label}</span>
      <div className={styles.fileRow}>
        {currentUrl && /^https?:\/\//.test(currentUrl) && (
          <a href={currentUrl} target="_blank" rel="noreferrer" className={styles.fileLink}>View current file</a>
        )}
        {pendingFile && <span className={styles.pendingFile}>{pendingFile.fileName} (pending upload)</span>}
        {!disabled && (
          <label className={styles.fileBtn}>
            {currentUrl ? 'Replace file' : 'Choose file'}
            <input type="file" onChange={onPick} hidden />
          </label>
        )}
      </div>
    </div>
  );
}
