import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth, setStoredToken, apiErrorMessage } from '../../shared/auth/index.js';
import { Button, Icon, LoadingState, ErrorState } from '../../components/ui/index.js';
import { startSalesOsSso, confirmLeaseCompany, submitSalesOsRenewal } from '../../services/sso.service.js';
import { uploadStageFile } from '../../services/upload.service.js';
import { CompleteDocumentModal } from '../renewDocument/CompleteDocumentModal.jsx';
import { ROUTES } from '../../constants/routes.js';
import styles from './SsoSalesOsPage.module.css';

/**
 * Landing page for the Sales OS ("Crystal Sales CRM" Existing Leads / KAM)
 * deep link: https://lease.crystalgrp.xyz/sso/sales-os?employeeCode=...&
 * existingLeadId=...&companyName=...&... . Deliberately outside
 * RequireAuth/AppShell (see app/App.jsx) — there is no session until this
 * page's own first call (POST /api/sso/sales-os/session) creates one by
 * employeeCode alone. See backend/src/services/salesOsRenewal.service.js
 * for what each step actually does server-side.
 *
 * Steps: authenticating -> (company picker, only if ambiguous) -> container
 * checklist -> the SAME "Update Agreement" modal Renew & Document uses
 * in-app (reused verbatim, bulk mode — one form applied to every selected
 * container, exactly like RenewDocumentPage.jsx's own multi-select action)
 * -> success. This is deliberately NOT a separate custom form: it must be
 * the exact same fields, saved through the exact same backend actions, so a
 * renewal entered via Sales OS looks identical in Lease to one entered by
 * an ops user in-app — see salesOsRenewal.service.js#saveRenewal.
 */
export function SsoSalesOsPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { reload } = useAuth();

  const [step, setStep] = useState('authenticating');
  const [error, setError] = useState('');
  const [context, setContext] = useState(null); // { existingLeadId, clientName, lm, successType, ... }
  const [candidates, setCandidates] = useState([]);
  const [containers, setContainers] = useState([]);
  const [selected, setSelected] = useState(() => new Set());
  const [formOpen, setFormOpen] = useState(false);
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await startSalesOsSso(searchParams);
        if (cancelled) return;
        setStoredToken(res.token);
        await reload();
        setContext(res.context);
        if (res.companyMatch.status === 'matched') {
          setContainers(res.containers);
          setStep(res.containers.length ? 'containers' : 'no-containers');
        } else if (res.companyMatch.status === 'ambiguous') {
          setCandidates(res.companyMatch.candidates);
          setStep('company-picker');
        } else {
          setError(`No Lease company found for "${res.context.companyNameRaw}". Create/link the company in Lease first.`);
          setStep('error');
        }
      } catch (e) {
        if (cancelled) return;
        setError(apiErrorMessage(e));
        setStep('error');
      }
    })();
    return () => { cancelled = true; };
    // Deliberately runs once — this is a landing page, not a re-fetchable view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pickCompany = async (companyName) => {
    setBusy(true);
    setError('');
    try {
      const res = await confirmLeaseCompany(context.existingLeadId, companyName);
      setContainers(res.containers);
      setStep(res.containers.length ? 'containers' : 'no-containers');
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleContainer = (containerNo) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(containerNo)) next.delete(containerNo); else next.add(containerNo);
    return next;
  });
  const selectAll = () => setSelected(new Set(containers.map((c) => c.containerNo)));
  const clearAll = () => setSelected(new Set());

  const selectedContainers = useMemo(() => containers.filter((c) => selected.has(c.containerNo)), [containers, selected]);

  /** Wired to CompleteDocumentModal's bulk `onSubmit` — same shape
   *  RenewDocumentPage.jsx#handleBulkDocSubmit uses: upload whatever files
   *  were chosen ONCE, then apply the same form values to every selected
   *  container. */
  const handleFormSubmit = async (form) => {
    setFormBusy(true);
    setFormError('');
    try {
      const [signedCopyUrl, poFileUrl] = await Promise.all([
        form.signedCopy ? uploadStageFile(form.signedCopy) : '',
        form.poFile ? uploadStageFile(form.poFile) : ''
      ]);

      const res = await submitSalesOsRenewal({
        existingLeadId: context.existingLeadId,
        successType: context.successType,
        lm: context.lm,
        clientName: context.clientName,
        requestId: context.requestId,
        containers: selectedContainers.map((c) => ({
          containerNo: c.containerNo,
          renewedDate: form.renewedDate,
          validTill: form.validTill,
          signedCopyUrl,
          poNo: form.poNo,
          poFileUrl,
          billingCycle: form.billingCycle,
          poValidity: form.poValidity,
          remarks: form.remarks
        }))
      });
      setSaved(res);
      setFormOpen(false);
      setStep('success');
    } catch (e) {
      setFormError(apiErrorMessage(e));
    } finally {
      setFormBusy(false);
    }
  };

  if (step === 'authenticating') return <LoadingState label="Signing you in…" />;
  if (step === 'error') return <div className={styles.shell}><ErrorState message={error} /></div>;

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <Icon name="container" />
        <div>
          <h1 className={styles.title}>Renewal — {context?.clientName}</h1>
          <p className={styles.subtitle}>via Sales OS · {context?.successType}{context?.lm ? ` · ${context.lm}` : ''}</p>
        </div>
      </header>

      {step === 'company-picker' && (
        <section className={styles.card}>
          <p className={styles.hint}>
            "{context?.companyNameRaw}" matches more than one Lease company — pick the right one.
          </p>
          <ul className={styles.pickerList}>
            {candidates.map((name) => (
              <li key={name}>
                <button type="button" className={styles.pickerItem} disabled={busy} onClick={() => pickCompany(name)}>
                  {name}
                </button>
              </li>
            ))}
          </ul>
          {error && <p className={styles.error}>{error}</p>}
        </section>
      )}

      {step === 'no-containers' && (
        <section className={styles.card}>
          <p className={styles.hint}>
            "{context?.clientName}" has no live containers in Lease right now, so there is nothing to renew here.
          </p>
        </section>
      )}

      {step === 'containers' && (
        <section className={styles.card}>
          <div className={styles.cardHead}>
            <p className={styles.hint}>Select which containers this renewal covers.</p>
            <div className={styles.selectRow}>
              <button type="button" className={styles.linkBtn} onClick={selectAll}>Select all</button>
              <button type="button" className={styles.linkBtn} onClick={clearAll}>Clear</button>
            </div>
          </div>
          <ul className={styles.list}>
            {containers.map((c) => (
              <li key={c.containerNo} className={styles.item}>
                <label className={styles.itemLabel}>
                  <input type="checkbox" checked={selected.has(c.containerNo)} onChange={() => toggleContainer(c.containerNo)} />
                  <span className={styles.containerNo}>{c.containerNo}</span>
                  {c.product && <span className={styles.meta}>{c.product}</span>}
                  {c.size && <span className={styles.meta}>{c.size}</span>}
                  {c.location && <span className={styles.meta}>{c.location}</span>}
                  {c.validUpto && <span className={styles.meta}>Valid {c.validUpto}</span>}
                  {typeof c.daysLeft === 'number' && (
                    <span className={styles.meta}>{c.daysLeft < 0 ? `${Math.abs(c.daysLeft)}d overdue` : `${c.daysLeft}d left`}</span>
                  )}
                </label>
              </li>
            ))}
          </ul>
          <div className={styles.footer}>
            <Button
              type="button"
              variant="primary"
              disabled={!selected.size}
              onClick={() => { setFormError(''); setFormOpen(true); }}
            >
              Continue{selected.size ? ` (${selected.size})` : ''}
            </Button>
          </div>
        </section>
      )}

      {step === 'success' && (
        <section className={styles.card}>
          <div className={styles.successWrap}>
            <Icon name="check-circle" size="lg" className={styles.successIcon} />
            <p className={styles.message}>
              Renewal saved for {saved?.containers?.length} container{saved?.containers?.length === 1 ? '' : 's'}.
            </p>
            <Button type="button" variant="primary" onClick={() => navigate(ROUTES.LEASE_EXPIRY)}>Go to Lease Expiry</Button>
          </div>
        </section>
      )}

      {/* The EXACT "Update Agreement" modal used in-app (Renew & Document
          page), reused as-is in its bulk mode — one form, applied to every
          selected container. See handleFormSubmit above for how it's wired
          into the SSO save. */}
      <CompleteDocumentModal
        open={formOpen}
        items={selectedContainers.map((c) => ({ containerNo: c.containerNo }))}
        submitting={formBusy}
        error={formError}
        onClose={() => setFormOpen(false)}
        onSubmit={handleFormSubmit}
      />
    </div>
  );
}
