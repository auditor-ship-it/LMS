import { useEffect, useMemo, useState } from 'react';
import {
  PageHeader, Card, Button, SearchBar, Pagination, DataGrid, renderCellValue
} from '../../components/ui/index.js';
import { useAsync } from '../../hooks/useAsync.js';
import { usePagination } from '../../hooks/usePagination.js';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import { usePermission } from '../../hooks/usePermission.js';
import { apiErrorMessage } from '../../shared/auth/index.js';
import {
  fetchMovementContainers, fetchMovementContainer, fetchMovements, submitMovement
} from '../../services/offLease.service.js';
import styles from './Stage9Page.module.css';

/**
 * Stage 9 — container movement entry.
 *
 * Not a pipeline stage: it appends one row per movement to its own sheet
 * instead of filling a column range on the container's tracking row, and it
 * gates nothing. See backend/src/services/stage9.service.js.
 *
 * For Movement Type = Offlease the container list comes from Stage 2 (the tab
 * labelled "Stage 2", internally stage 6 / Transportation) and the identity
 * fields are read-only — the backend re-derives them from Stage 2 on save
 * regardless of what is posted, so they can only ever be a preview of what
 * will be written.
 */

const MOVEMENT_TYPES = ['Offlease', 'Deployment', 'Return', 'Other'];

/** The only type whose containers come from Stage 2; the others describe
 *  movements of containers that are not sitting in that queue. */
const AUTOFILL_TYPE = 'Offlease';

const AUTO_FIELDS = ['clientName', 'leaseId', 'size', 'type', 'location'];

const BLANK = {
  movementType: '',
  containerNo: '',
  clientName: '',
  leaseId: '',
  size: '',
  type: '',
  location: '',
  movementDate: '',
  remarks: ''
};

/** Container + lease identifies a pending record — a container alone does not,
 *  since the same box can be off-leased under two leases at once. */
const optionKey = (c) => `${c.containerNo}::${c.leaseId}`;

export function Stage9Page({ embedded }) {
  const { canAct } = usePermission();
  const canEdit = canAct('offlease9');

  const [form, setForm] = useState(BLANK);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const autoFill = form.movementType === AUTOFILL_TYPE;

  // Stage 2 is the master source, re-read whenever the form switches into
  // Offlease so the dropdown can never offer a container that has moved on.
  const {
    data: sources, loading: sourcesLoading, error: sourcesError, reload: reloadSources
  } = useAsync(() => (autoFill ? fetchMovementContainers() : Promise.resolve([])), [autoFill]);

  const movements = useAsync(() => fetchMovements(), []);

  const containers = useMemo(() => sources || [], [sources]);

  /* A container shown twice needs its client to tell the two apart; one shown
     once reads better as just the number. */
  const duplicated = useMemo(() => {
    const seen = new Map();
    containers.forEach((c) => seen.set(c.containerNo, (seen.get(c.containerNo) || 0) + 1));
    return seen;
  }, [containers]);

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  /* Switching type clears the identity fields: they belong to the previously
     selected container and would otherwise be silently carried over onto a
     different one. */
  const onTypeChange = (movementType) => {
    setError('');
    setNotice('');
    setForm((f) => ({ ...f, movementType, containerNo: '', clientName: '', leaseId: '', size: '', type: '', location: '' }));
  };

  const onContainerPick = async (key) => {
    setError('');
    setNotice('');
    const picked = containers.find((c) => optionKey(c) === key);
    if (!picked) { set({ containerNo: '', clientName: '', leaseId: '', size: '', type: '', location: '' }); return; }

    /* Fill from the row already in hand so the form updates the instant the
       selection changes, then confirm against the API — which is authoritative
       and is what the save re-reads. They agree unless Stage 2 changed while
       this tab sat open, and then the API wins. */
    set({
      containerNo: picked.containerNo,
      clientName: picked.clientName,
      leaseId: picked.leaseId,
      size: picked.size,
      type: picked.type,
      location: picked.location
    });

    try {
      const fresh = await fetchMovementContainer(picked.containerNo);
      const match = fresh.multiple
        ? (fresh.matches.find((m) => m.leaseId === picked.leaseId) || fresh)
        : fresh;
      setForm((f) => (
        f.containerNo === picked.containerNo
          ? { ...f, ...Object.fromEntries(AUTO_FIELDS.map((k) => [k, match[k] || ''])) }
          : f // the user moved on while this was in flight — leave their choice alone
      ));
    } catch (e) {
      setError(apiErrorMessage(e));
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setNotice('');
    if (!form.movementType) { setError('Movement Type is required.'); return; }
    if (!form.containerNo.trim()) { setError('Container No is required.'); return; }

    setSaving(true);
    try {
      await submitMovement(form);
      setNotice(`Movement saved for ${form.containerNo}.`);
      setForm(BLANK);
      // Write, then read — one sequential reload, nothing racing it.
      await movements.reload();
      if (autoFill) reloadSources(); // the container may no longer be pending
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {!embedded && <PageHeader title="Stage 9" subtitle="Container Movement Entry" />}

      <Card title="New Movement">
        <form className={styles.form} onSubmit={submit}>
          <div className={styles.fieldGrid}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="s9-type">
                Movement Type <span className={styles.req}>*</span>
              </label>
              <select
                id="s9-type"
                value={form.movementType}
                disabled={!canEdit || saving}
                onChange={(e) => onTypeChange(e.target.value)}
              >
                <option value="">Select movement type…</option>
                {MOVEMENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="s9-container">
                Container No <span className={styles.req}>*</span>
              </label>
              {autoFill ? (
                <select
                  id="s9-container"
                  value={form.containerNo ? optionKey(form) : ''}
                  disabled={!canEdit || saving || sourcesLoading}
                  onChange={(e) => onContainerPick(e.target.value)}
                >
                  <option value="">
                    {sourcesLoading
                      ? 'Loading Stage 2 containers…'
                      : sourcesError
                        ? 'Could not load Stage 2 containers'
                        : containers.length
                          ? 'Select a pending Stage 2 container…'
                          : 'No containers pending at Stage 2'}
                  </option>
                  {containers.map((c) => (
                    <option key={optionKey(c)} value={optionKey(c)}>
                      {duplicated.get(c.containerNo) > 1 && c.clientName
                        ? `${c.containerNo} — ${c.clientName}`
                        : c.containerNo}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id="s9-container"
                  type="text"
                  value={form.containerNo}
                  disabled={!canEdit || saving}
                  placeholder={form.movementType ? 'Enter container number' : 'Select a movement type first'}
                  onChange={(e) => set({ containerNo: e.target.value.toUpperCase() })}
                />
              )}
            </div>

            {[
              ['clientName', 'Client Name'],
              ['leaseId', 'Lease ID'],
              ['size', 'Size'],
              ['type', 'Type'],
              ['location', 'Location']
            ].map(([key, label]) => (
              <div className={styles.field} key={key}>
                <label className={styles.label} htmlFor={`s9-${key}`}>{label}</label>
                <input
                  id={`s9-${key}`}
                  type="text"
                  value={form[key]}
                  readOnly={autoFill}
                  disabled={!canEdit || saving}
                  placeholder={autoFill ? 'Auto-filled from Stage 2' : ''}
                  onChange={autoFill ? undefined : (e) => set({ [key]: e.target.value })}
                />
              </div>
            ))}

            <div className={styles.field}>
              <label className={styles.label} htmlFor="s9-date">Movement Date</label>
              <input
                id="s9-date"
                type="date"
                value={form.movementDate}
                disabled={!canEdit || saving}
                onChange={(e) => set({ movementDate: e.target.value })}
              />
            </div>

            <div className={`${styles.field} ${styles.full}`}>
              <label className={styles.label} htmlFor="s9-remarks">Remarks</label>
              <textarea
                id="s9-remarks"
                value={form.remarks}
                disabled={!canEdit || saving}
                placeholder="e.g. Shifted to yard"
                onChange={(e) => set({ remarks: e.target.value })}
              />
            </div>
          </div>

          {autoFill && (
            <p className={styles.autoHint}>
              Client Name, Lease ID, Size, Type and Location are read from Stage 2 and saved from
              there — editing them here would not change what is written.
            </p>
          )}

          {error && <p className={styles.error}>{error}</p>}
          {notice && <p className={styles.success}>{notice}</p>}

          <div className={styles.actions}>
            <Button type="button" variant="secondary" disabled={saving} onClick={() => { setForm(BLANK); setError(''); setNotice(''); }}>
              Reset
            </Button>
            <Button type="submit" variant="primary" loading={saving} disabled={!canEdit}>
              {canEdit ? 'Save Movement' : 'No permission'}
            </Button>
          </div>
        </form>
      </Card>

      <MovementLog state={movements} />
    </>
  );
}

/** The Stage 9 sheet itself, newest first — read straight from Sheets, so a
 *  row appears here the moment it appears there. */
function MovementLog({ state }) {
  const { data, loading, error, reload } = state;
  const [search, setSearch] = useState('');
  const debounced = useDebouncedValue(search);

  const headers = data?.headers || [];
  const rows = data?.data || [];

  const filtered = useMemo(() => {
    const q = debounced.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => (r.row || []).some((c) => String(c ?? '').toLowerCase().includes(q)));
  }, [rows, debounced]);

  const { page, totalPages, pageRows, setPage, nextPage, prevPage, resetPage } = usePagination(filtered, 10);
  useEffect(() => { resetPage(); }, [debounced]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Card
      title="Logged Movements"
      actions={<Button variant="secondary" size="sm" onClick={reload}>Refresh</Button>}
    >
      <div className={styles.toolbar}>
        <SearchBar value={search} onChange={setSearch} placeholder="Search container, client, movement type…" />
        <span className={styles.count}>
          {filtered.length} movement{filtered.length === 1 ? '' : 's'}
        </span>
      </div>

      <DataGrid
        headers={headers}
        rows={pageRows}
        loading={loading}
        error={error}
        onRetry={reload}
        emptyMessage="No movements logged yet"
        rowKey={(r) => r._rowNum}
        renderRow={(values) => headers.map((_, i) => <td key={i}>{renderCellValue(values[i])}</td>)}
      />

      <Pagination page={page} totalPages={totalPages} onPrev={prevPage} onNext={nextPage} onPage={setPage} />
    </Card>
  );
}
