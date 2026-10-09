import { useEffect, useMemo, useState } from 'react';
import { PageHeader, Card, Button, StatCard, SearchBar, Pagination, DataGrid, renderCellValue } from '../../components/ui/index.js';
import { useAsync } from '../../hooks/useAsync.js';
import { usePagination } from '../../hooks/usePagination.js';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import { usePermission } from '../../hooks/usePermission.js';
import { useAutoRefresh } from '../../hooks/useAutoRefresh.js';
import { invalidate } from '../../shared/dataBus.js';
import { useAuth, apiErrorMessage } from '../../shared/auth/index.js';
import { fetchDocumentList, submitDocumentCompletion, saveDocumentDraft, submitSendBackToPending } from '../../services/renewDocument.service.js';
import { uploadStageFile } from '../../services/upload.service.js';
import { isRateOrAmountHeader } from '../../utils/isRateOrAmountHeader.js';
import { CompleteDocumentModal } from './CompleteDocumentModal.jsx';
import styles from './RenewDocumentPage.module.css';

// Kept out of the compact table view and shown only in the row detail panel.
const DETAIL_ONLY_HEADERS = /^(location|size|type|city|po)$/i;

const RESULT_CODE_TEXT = {
  INVALID_STATE: 'not in the document-upload stage',
  MISSING_PO: 'PO number/file required',
  MISSING_AGR: 'signed agreement copy required'
};

/**
 * Runs `fn` for each item ONE AT A TIME, in the same { status, value|reason }
 * shape Promise.allSettled returns — a drop-in replacement for it, not a new
 * contract describeBulkFailures has to learn.
 *
 * Bulk Save/Submit used to fire every container's request at once
 * (Promise.allSettled(items.map(...))). Each one does its own LIVE Sheets
 * read-then-write (completeDocStage/saveRenewalDraft's "re-read before a
 * write" guard — see expiry.service.js), and firing a dozen-plus of those in
 * the same instant is exactly the burst this project's shared Sheets quota
 * keeps failing under (same root cause documented in
 * mongoSheetData.service.js's own header note — "any burst of traffic...
 * tripped the... rate limit... repeatedly"). Confirmed live 2026-10-06: a
 * 7-of-14 Sales OS bulk Submit failed with no INVALID_STATE/MISSING_PO/
 * MISSING_AGR reason on any of the 7 — a quota/transient-error signature, not
 * a data problem (all 7 were still plain 'Documents Pending' rows). Running
 * these one at a time costs a little wall-clock time on a big batch, but
 * never exceeds the per-minute quota the way firing them all at once does.
 */
async function settleSequentially(items, fn) {
  const results = [];
  for (const item of items) {
    try {
      results.push({ status: 'fulfilled', value: await fn(item) });
    } catch (e) {
      results.push({ status: 'rejected', reason: e });
    }
  }
  return results;
}

/* Bulk Save/Submit failure summary — groups containers by the actual
   reason (server message or result code) instead of listing bare numbers. */
function describeBulkFailures(results, items, doneVerb) {
  const byReason = new Map();
  results.forEach((r, i) => {
    if (r.status !== 'rejected') return;
    const e = r.reason;
    const reason = RESULT_CODE_TEXT[e?.message] || apiErrorMessage(e) || 'Unknown error';
    if (!byReason.has(reason)) byReason.set(reason, []);
    byReason.get(reason).push(items[i].row?.[0]);
  });
  const failedCount = [...byReason.values()].reduce((n, list) => n + list.length, 0);
  if (!failedCount) return '';
  const detail = [...byReason.entries()].map(([reason, list]) => `${list.join(', ')} — ${reason}`).join(' | ');
  const tail = failedCount === items.length ? `None were ${doneVerb}.` : `The other ${items.length - failedCount} were ${doneVerb}.`;
  return `Failed for ${failedCount} of ${items.length}: ${detail}. ${tail}`;
}

/**
 * Renew & Document — post-renewal documentation (agreement/PO upload) for
 * containers whose lease has already been renewed. Backed by
 * GET /expiry?filter=documents.
 *
 * WORKFLOW CHANGE 2026-09-03, explicit request: this page used to have a
 * SECOND tab ("Renewed") for a "Renewed but lease period not updated yet"
 * intermediate state, with its own "Renew Pending" scorecard — a container
 * landed there when Lease Expiry's "Renew" button was clicked, and only
 * moved into THIS page's Documents queue after someone ran that tab's
 * "Update Period" step. Lease Expiry's "Renew" button now writes straight to
 * 'Documents Pending' (see LeaseExpiryPage.jsx), skipping that intermediate
 * state entirely, so nothing is ever meant to reach it again — the tab and
 * its scorecard were removed outright rather than left permanently showing
 * a static 0. Everything tied ONLY to that tab (fetchRenewList, RenewModal,
 * the Update Period action, the tab switcher) was removed with it — the
 * Documents form here already collects Renewed Date / Valid Till itself, so
 * no capability was lost.
 */
export function RenewDocumentPage() {
  const { data, loading, error, reload } = useAsync(fetchDocumentList, []);
  // Lease Expiry's Renew/Off-Lease actions write the same Deployed-sheet
  // columns this page reads — without this, arriving here after an action
  // there would still show whatever was last fetched (KeepAlivePages keeps
  // every visited page mounted and only fetches once per session).
  useAutoRefresh('deployed-sheet', reload);
  const { canAct } = usePermission();
  const { user } = useAuth();
  const canActRenew = canAct('renew');

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 250);
  const [selectedContainer, setSelectedContainer] = useState(null);

  const [docItem, setDocItem] = useState(null);
  const [docBusy, setDocBusy] = useState(false);
  const [docError, setDocError] = useState('');

  /* Save/Submit confirmation — explicit request 2026-10-01: neither action
     visibly changes this row (Agreement PDF/PO PDF only populate once Pushpa
     approves a Submit — see decideRenewalApproval), so without this message
     the row looks untouched and a successful save looks like it silently
     failed. Auto-dismisses, same pattern as ApiAccessPage.jsx's toast. */
  const [toast, setToast] = useState(null);
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  /* "Send Back" to Lease Expiry — explicit request 2026-09-30. Keyed by
     container (not a single boolean) so one row's in-flight request doesn't
     disable every other row's own button too. */
  const [sendBackBusyKey, setSendBackBusyKey] = useState('');
  const [sendBackError, setSendBackError] = useState('');

  /* Bulk selection, keyed by container number — same identity
     setSelectedContainer already uses for the single-row detail view, and
     stable across pagination/filtering (unlike a row index, which shifts
     depending on which page or filtered set it's read from). */
  const [selectedKeys, setSelectedKeys] = useState(() => new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState('');

  const headers = data?.headers || [];
  const rows = data?.data || [];

  // System-wide: rate/amount/pricing columns are hidden from every data grid.
  const visibleColIdx = useMemo(
    () => headers.map((_, i) => i).filter((i) => !isRateOrAmountHeader(headers[i])),
    [headers]
  );
  // The compact table view drops Location/Size/Type/City — those only show in the detail panel.
  const tableColIdx = useMemo(
    () => visibleColIdx.filter((i) => !DETAIL_ONLY_HEADERS.test(String(headers[i] || '').trim())),
    [visibleColIdx, headers]
  );
  const tableHeaders = tableColIdx.map((i) => headers[i]);

  const filtered = useMemo(() => {
    const term = debouncedSearch.trim().toLowerCase();
    if (!term) return rows;
    return rows.filter((r) => (r.row || []).some((v) => String(v ?? '').toLowerCase().includes(term)));
  }, [rows, debouncedSearch]);

  const { page, totalPages, pageRows, setPage, nextPage, prevPage, resetPage } = usePagination(filtered, 10);

  const selected = selectedContainer != null ? filtered.find((it) => it.row?.[0] === selectedContainer) : null;

  // Derived from `filtered`, not just the current page, so a selection made
  // on page 1 survives navigating to page 2.
  const selectedItems = useMemo(
    () => filtered.filter((r) => selectedKeys.has(r.row?.[0])),
    [filtered, selectedKeys]
  );

  const handleSearchChange = (v) => { setSearch(v); resetPage(); };

  const toggleRow = (key) => setSelectedKeys((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const toggleAllOnPage = () => setSelectedKeys((prev) => {
    const pageKeys = pageRows.map((r) => r.row?.[0]).filter(Boolean);
    const allSelected = pageKeys.length > 0 && pageKeys.every((k) => prev.has(k));
    const next = new Set(prev);
    pageKeys.forEach((k) => (allSelected ? next.delete(k) : next.add(k)));
    return next;
  });

  const openDoc = (item) => {
    setDocError('');
    setDocItem({
      containerNo: item.row?.[0],
      rowNum: item._rowNum,
      // Pre-fill from the DRAFT columns only (AA-AD plus the DRAFT_* PO/
      // Billing Cycle/PO Validity ones) — REDESIGNED 2026-09-29 (approval
      // workflow): Save/Submit no longer touch the real PO/Billing Cycle/PO
      // Validity columns on the row at all (see saveRenewalDraft/
      // completeDocStage's own doc comments on the backend) — only
      // decideRenewalApproval's Approve path ever writes those, and only
      // once approved, so the real columns can't be used to pre-fill a draft
      // anymore.
      draft: {
        renewedDate: item.draftRenewedDate || '',
        validTill: item.draftValidTill || '',
        remarks: item.draftRemarks || '',
        poNo: item.draftPoNo || '',
        poValidity: item.draftPoValidity || '',
        billingCycle: item.draftBillingCycle || '',
        submittedDate: item.renewalSubmittedDate || '',
        approvalStatus: item.approvalStatus || '',
        approvalRemarks: item.approvalRemarks || ''
      }
    });
  };

  /* Shared by Save and Submit — same payload shape, same uploads, only the
     backend call (and what happens to the modal/list after) differs. */
  const buildDocPayload = async (containerNo, rowNum, payload) => {
    // Uploaded concurrently, not one after the other — the PO file has no
    // reason to wait on the signed copy finishing first, and this was
    // roughly doubling the wait whenever a form carried both.
    const [signedCopyUrl, poFileUrl] = await Promise.all([
      payload.signedCopy ? uploadStageFile(payload.signedCopy) : '',
      payload.poFile ? uploadStageFile(payload.poFile) : ''
    ]);
    return {
      containerNo,
      renewedDate: payload.renewedDate,
      validTill: payload.validTill,
      signedCopyUrl,
      remarks: payload.remarks,
      userEmail: user?.email || '',
      poNo: payload.poNo,
      poFileUrl,
      billingCycle: payload.billingCycle,
      poValidity: payload.poValidity,
      rowNum
    };
  };

  const handleDocSubmit = async (payload) => {
    if (!docItem) return;
    setDocBusy(true);
    setDocError('');
    try {
      // docItem.rowNum: this exact Deployed row — see completeRenewalDocStage's
      // doc comment for why container number alone isn't safe here.
      const body = await buildDocPayload(docItem.containerNo, docItem.rowNum, payload);
      const result = await submitDocumentCompletion(body);
      if (result === 'INVALID_STATE') setDocError('Container is not in the document-upload stage.');
      else if (result === 'MISSING_PO') setDocError('A PO number/file URL is required first.');
      else if (result === 'MISSING_AGR') setDocError('A signed agreement copy URL is required first.');
      else {
        setDocItem(null); setSelectedContainer(null);
        setToast({ type: 'success', text: `${docItem.containerNo} submitted — now awaiting Pushpa's approval (Renew Approval Pending). Agreement/PO PDF will show here once she approves.` });
        await reload();
        invalidate('deployed-sheet');
      }
    } catch (e) {
      setDocError(apiErrorMessage(e));
    } finally {
      setDocBusy(false);
    }
  };

  /* "Save" — explicit request 2026-09-28: persists the draft, the container
     STAYS in Documents Pending (unlike Submit, which clears it out), so this
     closes the modal and reloads exactly like Submit success does — the row
     is still there, just now pre-filled with what was just saved. */
  const handleDocSave = async (payload) => {
    if (!docItem) return;
    setDocBusy(true);
    setDocError('');
    try {
      const body = await buildDocPayload(docItem.containerNo, docItem.rowNum, payload);
      const result = await saveDocumentDraft(body);
      if (result === 'INVALID_STATE') setDocError('Container is not in the document-upload stage.');
      else {
        setDocItem(null); setSelectedContainer(null);
        setToast({ type: 'success', text: `${docItem.containerNo} saved as a draft — it stays in this list unchanged until you Submit it and Pushpa approves.` });
        await reload();
        invalidate('deployed-sheet');
      }
    } catch (e) {
      setDocError(apiErrorMessage(e));
    } finally {
      setDocBusy(false);
    }
  };

  /* "Send Back" — explicit request 2026-09-30: reverses the Renew click that
     put this container into Documents Pending, returning it to Lease
     Expiry's own pending list. Reuses `reload`/`invalidate('deployed-sheet')`
     the same way every other action on this page already does — no separate
     confirmation dialog, same "direct click" convention as Update Agreement. */
  const handleSendBack = async (item) => {
    const containerNo = item.row?.[0];
    setSendBackBusyKey(containerNo);
    setSendBackError('');
    try {
      const result = await submitSendBackToPending(containerNo, item._rowNum);
      if (result === 'INVALID_STATE') setSendBackError(`${containerNo} is no longer in Documents Pending.`);
      else if (result === 'AWAITING_APPROVAL') setSendBackError(`${containerNo} has already been submitted for approval — decide it from Approval Pending instead.`);
      else {
        if (selectedContainer === containerNo) setSelectedContainer(null);
        await reload();
        invalidate('deployed-sheet');
      }
    } catch (e) {
      setSendBackError(apiErrorMessage(e));
    } finally {
      setSendBackBusyKey('');
    }
  };

  /* Bulk action — one form, same values applied to every selected
     container, run in parallel (not one-after-another) since these are
     independent writes to different rows. A per-container failure is
     reported by container number rather than failing the whole batch
     silently or losing which ones actually went through. */
  const handleBulkDocSubmit = async (payload) => {
    if (!selectedItems.length) return;
    setBulkBusy(true);
    setBulkError('');
    try {
      // Uploaded ONCE — every selected container gets the same file/URL,
      // per the "one form entry for the whole batch" request.
      const [signedCopyUrl, poFileUrl] = await Promise.all([
        payload.signedCopy ? uploadStageFile(payload.signedCopy) : '',
        payload.poFile ? uploadStageFile(payload.poFile) : ''
      ]);

      const results = await settleSequentially(selectedItems, async (it) => {
        const result = await submitDocumentCompletion({
          containerNo: it.row?.[0],
          renewedDate: payload.renewedDate,
          validTill: payload.validTill,
          signedCopyUrl,
          remarks: payload.remarks,
          userEmail: user?.email || '',
          poNo: payload.poNo,
          poFileUrl,
          billingCycle: payload.billingCycle,
          poValidity: payload.poValidity,
          rowNum: it._rowNum
        });
        if (result === 'INVALID_STATE' || result === 'MISSING_PO' || result === 'MISSING_AGR') {
          throw new Error(result);
        }
      });
      const failureText = describeBulkFailures(results, selectedItems, 'submitted');
      if (failureText) {
        setBulkError(failureText);
      } else {
        setBulkOpen(false);
        setSelectedKeys(new Set());
        setToast({ type: 'success', text: `${selectedItems.length} container(s) submitted — now awaiting Pushpa's approval (Renew Approval Pending). Agreement/PO PDF will show once approved.` });
      }
      await reload();
      invalidate('deployed-sheet');
    } catch (e) {
      setBulkError(apiErrorMessage(e));
    } finally {
      setBulkBusy(false);
    }
  };

  /* Bulk "Save" — same shape as handleBulkDocSubmit, but nothing required
     (a draft can be partial) so there's no MISSING_PO/MISSING_AGR case to
     check, and every selected container stays in Documents Pending. */
  const handleBulkDocSave = async (payload) => {
    if (!selectedItems.length) return;
    setBulkBusy(true);
    setBulkError('');
    try {
      const [signedCopyUrl, poFileUrl] = await Promise.all([
        payload.signedCopy ? uploadStageFile(payload.signedCopy) : '',
        payload.poFile ? uploadStageFile(payload.poFile) : ''
      ]);

      const results = await settleSequentially(selectedItems, async (it) => {
        const result = await saveDocumentDraft({
          containerNo: it.row?.[0],
          renewedDate: payload.renewedDate,
          validTill: payload.validTill,
          signedCopyUrl,
          remarks: payload.remarks,
          poNo: payload.poNo,
          poFileUrl,
          billingCycle: payload.billingCycle,
          poValidity: payload.poValidity,
          rowNum: it._rowNum
        });
        if (result === 'INVALID_STATE') throw new Error(result);
      });
      const failureText = describeBulkFailures(results, selectedItems, 'saved');
      if (failureText) {
        setBulkError(failureText);
      } else {
        setBulkOpen(false);
        setSelectedKeys(new Set());
        setToast({ type: 'success', text: `${selectedItems.length} container(s) saved as a draft — they stay in this list unchanged until Submitted and approved.` });
      }
      await reload();
      invalidate('deployed-sheet');
    } catch (e) {
      setBulkError(apiErrorMessage(e));
    } finally {
      setBulkBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Renew & Document"
        subtitle="Complete post-renewal documentation for renewed containers"
        actions={<Button variant="secondary" size="sm" onClick={reload}>Refresh</Button>}
      />

      {toast && (
        <div className={`${styles.banner} ${toast.type === 'success' ? styles.bannerSuccess : ''}`}>
          {toast.text}
        </div>
      )}

      <div className={styles.kpiRow}>
        <StatCard
          icon="edit" label="Renew Pending" value={rows.length} tint="amber"
          footnote={rows.length > 0 ? 'Needs agreement/PO upload' : undefined}
        />
      </div>

      <Card>
        {!selected ? (
          <>
            <div className={styles.toolbar}>
              <SearchBar value={search} onChange={handleSearchChange} placeholder="Search container, client…" />
            </div>
            {sendBackError && <p className={styles.actionError}>{sendBackError}</p>}

            {/* Only when there's something to act on — a scoped/view-only
                caller can select rows (harmless) but has no action to run
                on them, so the bar showing an "Update" button with nothing
                behind it would be misleading. */}
            {canActRenew && selectedItems.length > 0 && (
              <div className={styles.bulkBar}>
                <span className={styles.bulkCount}>{selectedItems.length} selected</span>
                <Button size="sm" variant="secondary" onClick={() => setSelectedKeys(new Set())}>Clear</Button>
                <Button size="sm" variant="primary" onClick={() => { setBulkError(''); setBulkOpen(true); }}>
                  Update Agreement ({selectedItems.length})
                </Button>
              </div>
            )}

            <DataGrid
              className={styles.vTable}
              /* No 'Action' header here: DataGrid appends its own 'Actions'
                 column whenever renderActions is passed. Adding one manually
                 gave two headers for one cell, so the button sat under
                 'Action' and 'Actions' rendered permanently empty. */
              headers={tableHeaders}
              rows={pageRows}
              loading={loading}
              error={error}
              onRetry={reload}
              emptyMessage="No containers awaiting document completion"
              selectable={canActRenew}
              selectedKeys={selectedKeys}
              onToggleRow={toggleRow}
              onToggleAll={toggleAllOnPage}
              rowKey={(r) => r.row?.[0]}
              renderRow={(values, item) => tableColIdx.map((ci) => (
                <td key={ci} className={styles.clickCell} onClick={() => setSelectedContainer(item.row?.[0])}>
                  {renderCellValue(values[ci])}
                </td>
              ))}
              renderActions={(item) => (
                canActRenew
                  ? <Button size="sm" variant="primary" onClick={() => openDoc(item)}>Update Agreement</Button>
                  : <span className={styles.viewOnly}>View only</span>
              )}
            />

            <Pagination page={page} totalPages={totalPages} onPrev={prevPage} onNext={nextPage} onPage={setPage} />
          </>
        ) : (
          <RenewDocumentDetail
            item={selected}
            headers={headers}
            visibleColIdx={visibleColIdx}
            total={filtered.length}
            canAct={canActRenew}
            sendBackBusy={sendBackBusyKey === selected.row?.[0]}
            onBack={() => setSelectedContainer(null)}
            onAction={() => openDoc(selected)}
            onSendBack={() => handleSendBack(selected)}
          />
        )}
      </Card>

      <CompleteDocumentModal
        open={!!docItem}
        item={docItem}
        submitting={docBusy}
        error={docError}
        onClose={() => setDocItem(null)}
        onSubmit={handleDocSubmit}
        onSave={handleDocSave}
      />

      <CompleteDocumentModal
        open={bulkOpen}
        items={selectedItems.map((it) => ({ containerNo: it.row?.[0] }))}
        submitting={bulkBusy}
        error={bulkError}
        onClose={() => setBulkOpen(false)}
        onSubmit={handleBulkDocSubmit}
        onSave={handleBulkDocSave}
      />
    </>
  );
}

function RenewDocumentDetail({ item, headers, visibleColIdx, total, canAct, sendBackBusy, onBack, onAction, onSendBack }) {
  return (
    <div>
      <Button variant="secondary" size="sm" onClick={onBack} className={styles.backBtn}>← Back to List ({total})</Button>

      <div className={styles.detailCard}>
        <div className={styles.detailHeader}>
          <h4 className={styles.detailTitle}>{item.row[0]}</h4>
        </div>

        <div className={styles.detailGrid}>
          {visibleColIdx.map((ci) => (
            <div key={ci} className={styles.detailField}>
              <div className={styles.detailLabel}>{headers[ci] || `Column ${ci + 1}`}</div>
              <div className={styles.detailValue}>{renderCellValue(item.row[ci])}</div>
            </div>
          ))}
        </div>

        <div className={styles.detailFooter}>
          {canAct ? (
            <div className={styles.rowActions}>
              <Button size="lg" variant="primary" onClick={onAction}>Update Agreement</Button>
              <Button size="lg" variant="secondary" loading={sendBackBusy} onClick={onSendBack}>Send Back</Button>
            </div>
          ) : (
            <span className={styles.viewOnly}>View only</span>
          )}
        </div>
      </div>
    </div>
  );
}
