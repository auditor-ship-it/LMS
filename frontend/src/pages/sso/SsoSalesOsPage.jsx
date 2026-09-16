import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth, setStoredToken, apiErrorMessage } from '../../shared/auth/index.js';
import { Button, Icon, LoadingState, ErrorState, FileUpload, Select } from '../../components/ui/index.js';
import { startSalesOsSso, confirmLeaseCompany, submitSalesOsRenewal } from '../../services/sso.service.js';
import { ROUTES } from '../../constants/routes.js';
import styles from './SsoSalesOsPage.module.css';

const emptyLine = () => ({ fromDate: '', toDate: '', monthlyRent: '', totalValue: '', remark: '' });
const SUCCESS_TYPES = ['Renewal', 'Up sell', 'Cross sell', 'AMC'].map((v) => ({ value: v, label: v }));

/**
 * Landing page for the Sales OS ("Crystal Sales CRM" Existing Leads / KAM)
 * deep link: https://lease.crystalgrp.xyz/sso/sales-os?employeeCode=...&
 * existingLeadId=...&companyName=...&... . Deliberately outside
 * RequireAuth/AppShell (see app/App.jsx) — there is no session until this
 * page's own first call (POST /api/sso/sales-os/session) creates one by
 * employeeCode alone. See backend/src/services/salesOsRenewal.service.js
 * for what each step actually does server-side; this component is purely
 * the wizard shell around it: authenticating -> (company picker, only if
 * ambiguous) -> container checklist -> renewal form -> success.
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
  const [lines, setLines] = useState({}); // containerNo -> line fields
  const [shared, setShared] = useState({ successType: 'Renewal', lm: '' });
  const [addendum, setAddendum] = useState(null);
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
        setShared({ successType: res.context.successType || 'Renewal', lm: res.context.lm || '' });
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

  const proceedToForm = () => {
    setLines((prev) => {
      const next = { ...prev };
      for (const containerNo of selected) if (!next[containerNo]) next[containerNo] = emptyLine();
      return next;
    });
    setStep('form');
  };

  const updateLine = (containerNo, field, value) => {
    setLines((prev) => ({ ...prev, [containerNo]: { ...prev[containerNo], [field]: value } }));
  };

  /** Copies From/To/Monthly Rent from the first selected line onto every
   *  other selected line — the "shared fields + per-line overrides" the
   *  wizard is meant to support without forcing identical retyping. */
  const applyFirstToAll = () => {
    const [first, ...rest] = [...selected];
    if (!first || !rest.length) return;
    const src = lines[first];
    setLines((prev) => {
      const next = { ...prev };
      for (const containerNo of rest) {
        next[containerNo] = { ...next[containerNo], fromDate: src.fromDate, toDate: src.toDate, monthlyRent: src.monthlyRent };
      }
      return next;
    });
  };

  const selectedContainers = useMemo(() => containers.filter((c) => selected.has(c.containerNo)), [containers, selected]);
  const totalValue = useMemo(
    () => selectedContainers.reduce((sum, c) => sum + (Number(lines[c.containerNo]?.totalValue) || 0), 0),
    [selectedContainers, lines]
  );

  const submit = async () => {
    setError('');
    for (const c of selectedContainers) {
      const line = lines[c.containerNo] || {};
      if (!line.fromDate || !line.toDate) {
        setError(`${c.containerNo}: From Date and To Date are required.`);
        return;
      }
    }
    setBusy(true);
    try {
      const res = await submitSalesOsRenewal({
        existingLeadId: context.existingLeadId,
        successType: shared.successType,
        lm: shared.lm,
        clientName: context.clientName,
        requestId: context.requestId,
        containers: selectedContainers.map((c) => ({ containerNo: c.containerNo, ...lines[c.containerNo] })),
        addendum: addendum || undefined
      });
      setSaved(res);
      setStep('success');
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusy(false);
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
            <Button type="button" variant="primary" disabled={!selected.size} onClick={proceedToForm}>
              Continue{selected.size ? ` (${selected.size})` : ''}
            </Button>
          </div>
        </section>
      )}

      {step === 'form' && (
        <section className={styles.card}>
          <div className={styles.sharedRow}>
            <label className={styles.field}>
              <span className={styles.label}>Success Type</span>
              <Select
                value={shared.successType}
                onChange={(v) => setShared((s) => ({ ...s, successType: v }))}
                options={SUCCESS_TYPES}
                ariaLabel="Success Type"
              />
            </label>
            <label className={styles.field}>
              <span className={styles.label}>LM</span>
              <input className={styles.input} value={shared.lm} onChange={(e) => setShared((s) => ({ ...s, lm: e.target.value }))} />
            </label>
            {selectedContainers.length > 1 && (
              <button type="button" className={styles.linkBtn} onClick={applyFirstToAll}>
                Copy first line's dates &amp; rent to all
              </button>
            )}
          </div>

          {selectedContainers.map((c) => {
            const line = lines[c.containerNo] || emptyLine();
            return (
              <fieldset key={c.containerNo} className={styles.lineCard}>
                <legend className={styles.lineTitle}>
                  {c.containerNo}
                  {c.product ? ` · ${c.product}` : ''}
                  {c.size ? ` · ${c.size}` : ''}
                  {c.validUpto ? ` · prev. valid ${c.validUpto}` : ''}
                </legend>
                <div className={styles.lineGrid}>
                  <label className={styles.field}>
                    <span className={styles.label}>From Date</span>
                    <input type="date" className={styles.input} value={line.fromDate} onChange={(e) => updateLine(c.containerNo, 'fromDate', e.target.value)} required />
                  </label>
                  <label className={styles.field}>
                    <span className={styles.label}>To Date</span>
                    <input type="date" className={styles.input} value={line.toDate} onChange={(e) => updateLine(c.containerNo, 'toDate', e.target.value)} required />
                  </label>
                  <label className={styles.field}>
                    <span className={styles.label}>Monthly Rent</span>
                    <input type="number" min="0" className={styles.input} value={line.monthlyRent} onChange={(e) => updateLine(c.containerNo, 'monthlyRent', e.target.value)} />
                  </label>
                  <label className={styles.field}>
                    <span className={styles.label}>Total Value</span>
                    <input type="number" min="0" className={styles.input} value={line.totalValue} onChange={(e) => updateLine(c.containerNo, 'totalValue', e.target.value)} />
                  </label>
                  <label className={`${styles.field} ${styles.fieldWide}`}>
                    <span className={styles.label}>Remark</span>
                    <input className={styles.input} value={line.remark} onChange={(e) => updateLine(c.containerNo, 'remark', e.target.value)} />
                  </label>
                </div>
              </fieldset>
            );
          })}

          <div className={styles.addendumRow}>
            <FileUpload label={addendum ? 'Change signed addendum' : 'Upload signed addendum'} onSelected={setAddendum} accept=".pdf,.jpg,.jpeg,.png" />
          </div>

          {totalValue > 0 && <p className={styles.totalLine}>Total value: {totalValue.toLocaleString('en-IN')}</p>}
          {error && <p className={styles.error}>{error}</p>}

          <div className={styles.footer}>
            <Button type="button" variant="secondary" disabled={busy} onClick={() => setStep('containers')}>Back</Button>
            <Button type="button" variant="primary" loading={busy} onClick={submit}>Save Renewal</Button>
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
    </div>
  );
}
