import { useMemo, useState } from 'react';
import { LoadingState, ErrorState, EmptyState, Icon, Button, RichTextEditor } from '../../components/ui/index.js';
import { apiErrorMessage } from '../../shared/auth/index.js';
import { postRemark, editRemark, removeRemark, fetchRemarkThread } from '../../services/offLease.service.js';
import { STAGES, isReadOnlyStage } from '../../constants/stages.js';
import { usePermission } from '../../hooks/usePermission.js';
import { StageDetailModal } from '../stages/StageDetailModal.jsx';
import styles from './OrderBookView.module.css';

/**
 * Off-Lease dashboard, order-book layout — one row per off-lease record with
 * the whole pipeline collapsed into a strip of numbered chips, so where every
 * container has got to is readable down a single column without opening
 * anything.
 *
 * Same data as the table view (GET /offlease/dashboard); this is a second
 * presentation of it, not a second source. It reads and never writes — the
 * status pill links through to the tab that actually owns the action.
 */

/** The chips, left to right: Stage 1, the approval gate, then the rest of the
 *  workflow. The gate is drawn as "1A" rather than a stage number because it
 *  is a decision between stages, not a stage.
 *
 *  Each chip opens that stage's own tab (onOpenTab) when clicked, same as
 *  the status pill beside them -- a completed or future chip is just as
 *  clickable as the current one, so any stage's record is one click away
 *  regardless of where the container actually is right now. */
const GATE_CHIP = '1A';

function buildChips(item) {
  const [first, ...rest] = STAGES;
  const approval = String(item.approvalStatus || '').trim().toLowerCase();
  const stageOf = (n) => item.stages?.find((s) => s.stage === n);

  const chip = (stage) => {
    const s = stageOf(stage.number);
    return {
      key: `s${stage.number}`,
      label: String(stage.display),
      title: `Stage ${stage.display} · ${stage.label}${s?.done ? ` — completed ${s.timestamp || ''}`.trimEnd() : ' — pending'}`,
      tab: `stage${stage.number}`,
      stageNumber: stage.number,
      tone: s?.done ? 'done' : item.currentStageNum === stage.number ? 'current' : 'future'
    };
  };

  const gate = {
    key: 'gate',
    label: GATE_CHIP,
    title: `Intimation Approval — ${approval || 'pending'}`,
    tab: 'approval',
    tone: approval === 'approved' ? 'done'
      : approval === 'rejected' ? 'rejected'
        : item.stageClass === 'approval' ? 'current' : 'future'
  };

  return [chip(first), gate, ...rest.map(chip)];
}

/** Status pill wording and tone, and which tab owns acting on it. */
function statusOf(item) {
  switch (item.stageClass) {
    case 'approval': return { label: 'Pending approval', tone: 'warn', tab: 'approval' };
    case 'rejected': return { label: 'Rejected', tone: 'danger', tab: null };
    case 'done': return { label: 'Released', tone: 'success', tab: null };
    default: return {
      label: item.currentStage || 'In progress',
      tone: 'info',
      tab: item.currentStageNum ? `stage${item.currentStageNum}` : null
    };
  }
}

/**
 * The live remark for one record — the latest comment, plus an inline rich-text
 * composer to add another. Remarks are written here, not read out of the stage
 * columns: a stage remark belongs to its stage and freezes when that stage
 * completes, whereas this is the running commentary on the record.
 */
function RemarkCell({ item, onSaved }) {
  const [open, setOpen] = useState(false);
  const [html, setHtml] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  /* What this cell currently shows. Seeded from the dashboard row, then
     maintained locally after a write: reloading the whole dashboard to reflect
     one remark meant refetching all 35 records (seconds, and a Sheets read) on
     every save and delete, which is what made the button sit spinning. */
  const [local, setLocal] = useState(null);
  const view = local || {
    html: item.remarkHtml, on: item.remarkOn, by: item.remarkBy, count: item.remarkCount
  };

  /* The full thread, fetched only when the rail is first hovered. Loading it
     with the dashboard would mean one request per record for history most
     rows never get looked at. */
  const [thread, setThread] = useState(null);
  const [threadBusy, setThreadBusy] = useState(false);
  const [threadError, setThreadError] = useState('');
  /* Which existing remark is being edited — null means the composer is
     writing a NEW one. Edit and add share the same editor. */
  const [editingId, setEditingId] = useState(null);

  const loadThread = async () => {
    if (thread || threadBusy) return;
    setThreadBusy(true);
    setThreadError('');
    try {
      setThread(await fetchRemarkThread(item.container, item.leaseId));
    } catch (e) {
      /* Surfaced, not swallowed: showing "No history" for a failed read would
         claim the remarks are gone, and the Delete button would vanish with
         them. Left unset so the next hover retries. */
      setThreadError(apiErrorMessage(e));
    } finally {
      setThreadBusy(false);
    }
  };

  const beginEdit = (r) => {
    setEditingId(r.id);
    setHtml(r.html);
    setError('');
    setOpen(true);
  };

  const save = async () => {
    setError('');
    setBusy(true);
    try {
      const saved = editingId
        ? await editRemark(item.container, editingId, html)
        : await postRemark(item.container, item.leaseId, html);
      setOpen(false);
      setEditingId(null);
      setHtml('');
      setThread(null); // stale now — refetched on the next hover
      /* An edit replaces the newest entry only if that IS the newest; a new
         remark always becomes it and adds to the count. */
      setLocal({
        html: saved?.html ?? view.html,
        on: saved?.timestamp ?? view.on,
        by: saved?.enteredBy ?? view.by,
        count: editingId ? view.count : (view.count || 0) + 1
      });
      onSaved?.(item, saved);
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (r) => {
    setThreadError('');
    setBusy(true);
    try {
      await removeRemark(item.container, r.id);
      /* Drop it from the thread in place rather than refetching: the delete
         already told us it succeeded, and the surviving entries are unchanged. */
      const left = (thread || []).filter((x) => x.id !== r.id);
      setThread(left);
      const newest = left[0];
      setLocal({
        html: newest?.html || '',
        on: newest?.timestamp || '',
        by: newest?.enteredBy || '',
        count: left.length
      });
    } catch (e) {
      setThreadError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    /* The whole cell is interactive — writing, editing and browsing history
       all happen in place, so no click here should also open the record. */
    <div
      className={styles.remarkCol}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className={styles.remarkHead}>
        <span className={styles.sideLabel}>Remark</span>

        {/* The rail: one tick per stored remark, so the depth of the thread is
            visible without opening anything. Hovering loads and shows it.
            Nothing is ever replaced — every remark is kept, and this is how
            the older ones are reached. */}
        {view.count > 0 && (
          <span
            className={styles.rail}
            onMouseEnter={loadThread}
            onFocus={loadThread}
            tabIndex={0}
            role="button"
            aria-label={`${view.count} remark${view.count === 1 ? '' : 's'} — show history`}
          >
            {/* Capped so a long thread cannot stretch the row; the count next
                to it stays exact. */}
            {Array.from({ length: Math.min(view.count, 6) }, (_, i) => (
              <i key={i} className={styles.railTick} />
            ))}
            <span className={styles.railCount}>{view.count}</span>

            <span className={styles.railPop} role="tooltip">
              <span className={styles.railPopHead}>
                {view.count} remark{view.count === 1 ? '' : 's'}
              </span>
              {threadBusy && <span className={styles.railPopMeta}>Loading…</span>}
              {thread?.map((r) => (
                <span className={styles.railItem} key={r.id}>
                  <span className={styles.railItemBody} dangerouslySetInnerHTML={{ __html: r.html }} />
                  <span className={styles.railItemFoot}>
                    <span className={styles.railPopMeta}>
                      {[r.timestamp, r.enteredBy].filter(Boolean).join(' · ')}
                      {r.editedOn && ' · edited'}
                    </span>
                    {/* Always offered; the server rejects anyone who is not the
                        author (or a roles admin), so the UI does not have to
                        know who may act — and cannot get it wrong. */}
                    <button type="button" className={styles.railAction} onClick={() => beginEdit(r)}>Edit</button>
                    <button
                      type="button"
                      className={`${styles.railAction} ${styles.railDanger}`}
                      onClick={() => remove(r)}
                      disabled={busy}
                    >
                      Delete
                    </button>
                  </span>
                </span>
              ))}
              {threadError && <span className={styles.remarkError}>{threadError}</span>}
              {thread && !thread.length && !threadBusy && <span className={styles.railPopMeta}>No history</span>}
            </span>
          </span>
        )}

        {!open && (
          <button type="button" className={styles.remarkAdd} onClick={() => setOpen(true)}>
            <Icon name="edit" className={styles.remarkAddIcon} />
            {view.html ? 'Edit' : 'New'}
          </button>
        )}
      </div>

      {!open && (view.html
        ? (
          <>
            {/* Server-sanitised on the way in — the sheet only ever holds the
                allow-listed subset, never script/style/attributes. */}
            <div className={styles.remarkText} dangerouslySetInnerHTML={{ __html: view.html }} />
            {(view.on || view.by) && (
              <div className={styles.remarkOn}>{[view.on, view.by].filter(Boolean).join(' · ')}</div>
            )}
          </>
        )
        : <p className={styles.remarkEmpty}>—</p>)}

      {open && (
        <div className={styles.remarkEditor}>
          <RichTextEditor
            value={html}
            onChange={setHtml}
            placeholder={editingId ? 'Edit this remark…' : 'Add a remark…'}
            disabled={busy}
            autoFocus
          />
          {error && <p className={styles.remarkError}>{error}</p>}
          <div className={styles.remarkActions}>
            <Button
              size="sm" variant="secondary" disabled={busy}
              onClick={() => { setOpen(false); setEditingId(null); setHtml(''); setError(''); }}
            >
              Cancel
            </Button>
            <Button size="sm" variant="primary" loading={busy} onClick={save}>
              {editingId ? 'Update' : 'Save'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function OrderBookView({ items, loading, error, onRetry, onOpenTab, searching, onRemarkSaved, onOpenRecord, onStageSaved }) {
  const { canAct } = usePermission();
  /* Which record+stage's own form is open, or null. Distinct from
     onOpenRecord (the read-only all-stage history modal) -- this is the
     single stage's EDITABLE (or, for an already-completed stage, view-only)
     form, the same StageDetailModal the Stage N tab's own pending list
     opens, just reached directly from this record's chip instead. */
  const [stageForm, setStageForm] = useState(null); // { container, stageNumber, readOnly, identityOnly } | null

  /* A stage TYPE can be read-only altogether (e.g. Transportation -- a
     master list with no form at all), same rule StagePageBase applies.
     Layered under that: THIS record's chip tone decides whether ITS row is
     editable right now -- 'current' is the one stage actually open for
     action; 'done' may be reviewed but not overwritten; 'future' cannot be
     opened at all until the workflow reaches it. */
  const openStageChip = (containerNo, chip) => {
    if (chip.tone === 'future') return; // locked -- not clickable
    const readOnlyType = isReadOnlyStage(chip.stageNumber);
    const canEditNow = !readOnlyType && chip.tone === 'current' && canAct(`offlease${chip.stageNumber}`);
    setStageForm({ container: containerNo, stageNumber: chip.stageNumber, readOnly: !canEditNow, identityOnly: readOnlyType });
  };
  const rows = useMemo(() => items.map((it) => ({
    it, chips: buildChips(it), status: statusOf(it)
  })), [items]);

  if (loading) return <LoadingState label="Loading pipeline…" />;
  if (error) return <ErrorState message={error} onRetry={onRetry} />;
  if (!rows.length) {
    return <EmptyState message="No active off-lease containers" hint={searching ? 'Try a different search' : undefined} />;
  }

  return (
    <>
      <div className={styles.book}>
      {rows.map(({ it, chips, status }) => (
        <div
          className={styles.row}
          key={`${it.leaseId || ''}-${it.container}`}
          role="button"
          tabIndex={0}
          onClick={() => onOpenRecord?.(it)}
          /* Only when the ROW ITSELF is focused. Without the target check this
             fired for every key event bubbling up from inside — typing a space
             in the remark editor opened the record. The row holds a text
             editor, buttons and a hover rail, so it must never claim keys
             pressed within them. */
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return;
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenRecord?.(it); }
          }}
        >
          <div className={styles.idCol}>
            <div className={styles.date}>{it.deployedDate || '—'}</div>
            <div className={styles.leaseId}>{it.leaseId || '—'}</div>
            <div className={styles.kind}>LEASE</div>
            {it.raisedBy && <div className={styles.owner}>{it.raisedBy}</div>}
          </div>

          <div className={styles.mainCol}>
            <div className={styles.client}>{it.clientName || 'Unknown client'}</div>
            {/* Spec, code and location on one line — three short values on
                three lines left a column of white space beside them. */}
            <div className={styles.meta}>
              <span>{[it.size, it.type].filter(Boolean).join(' ') || 'Container'}</span>
              {it.clientCode && <span className={styles.chipCode}>{it.clientCode}</span>}
              {it.location && (
                <span className={styles.location}>
                  <Icon name="pin" className={styles.locationIcon} />
                  {it.location}
                </span>
              )}
            </div>

            <div className={styles.strip}>
              {chips.map((c) => {
                /* A real stage chip (c.stageNumber set) opens that STAGE'S
                   OWN form for THIS record -- editable only while it is the
                   current stage, view-only once done, locked while future.
                   The gate chip has no form of its own (approval is a
                   two-button decision, not a set of fields), so it keeps
                   jumping to the Approval tab, same as the status pill --
                   only while it is actually the thing waiting on someone. */
                const clickable = c.stageNumber != null ? c.tone !== 'future' : c.tone === 'current';
                if (!clickable) {
                  return (
                    <span key={c.key} className={`${styles.chip} ${styles[c.tone]}`} title={c.title}>
                      {c.label}
                    </span>
                  );
                }
                return (
                  <button
                    key={c.key}
                    type="button"
                    className={`${styles.chip} ${styles[c.tone]} ${styles.chipLink}`}
                    title={c.title}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (c.stageNumber != null) openStageChip(it.container, c);
                      else onOpenTab?.(c.tab);
                    }}
                  >
                    {c.label}
                  </button>
                );
              })}
              {status.tab ? (
                <button
                  type="button"
                  className={`${styles.status} ${styles[status.tone]} ${styles.statusLink}`}
                  onClick={(e) => { e.stopPropagation(); onOpenTab?.(status.tab); }}
                >
                  {status.label}
                </button>
              ) : (
                <span className={`${styles.status} ${styles[status.tone]}`}>{status.label}</span>
              )}
            </div>
          </div>

          <RemarkCell item={it} onSaved={onRemarkSaved} />

          <div className={styles.sideCol}>
            <div className={styles.sideLabel}>Container</div>
            <div className={styles.containerNo}>
              <Icon name="container" className={styles.containerIcon} />
              <span>{it.container}</span>
            </div>
            <div className={styles.sideLabel}>Valid upto</div>
            <div className={styles.sideValue}>{it.validUpto || '—'}</div>
          </div>
        </div>
      ))}
    </div>

      {stageForm && (
        <StageDetailModal
          stageNumber={stageForm.stageNumber}
          containerNo={stageForm.container}
          readOnly={stageForm.readOnly}
          identityOnly={stageForm.identityOnly}
          onClose={() => setStageForm(null)}
          onSaved={() => { setStageForm(null); onStageSaved?.(); }}
        />
      )}
    </>
  );
}
