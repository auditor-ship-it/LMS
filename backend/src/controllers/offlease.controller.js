import * as offLeaseService from '../services/offlease.service.js';
import * as stage9Service from '../services/stage9.service.js';
import * as remarksService from '../services/offleaseRemarks.service.js';
import * as stage8Service from '../services/stage8.service.js';
import * as stage3FormService from '../services/stage3Form.service.js';
import * as slaService from '../services/offleaseSla.service.js';
import { assertRolesAdmin } from '../services/roles.service.js';
import { notFound } from '../utils/AppError.js';
import { isRateOrAmountHeader } from '../utils/isRateOrAmountHeader.js';

/* ---- Core 8-stage pipeline ---- */

/** Internal stage 6 — the tab shown as "Stage 2 (Transportation)". Read-only,
 *  and the only stage enriched from the external FMS STAGE-8 sheet. */
const STAGE2_INTERNAL = 6;

/** Internal stage 7 — the tab shown as "Stage 3 (Gate In)". */
const STAGE3_INTERNAL = 7;

/** Internal stage 3 — the tab shown as "Stage 4 (Inspection Checklist)". */
const INSPECTION_INTERNAL = 3;

/** Internal stage 5 — the tab shown as "Stage 5 (Billing Reconciliation)". */
const BILLING_INTERNAL = 5;

/** Cache/disk-only read (see stage3Form.service.js) — cheap enough to always
 *  resolve, needed by every stage from Gate In onward. Container -> its
 *  Stage 3 form rows; resolved per-row against that row's OWN client inside
 *  offlease.service.js (see pickGateFormForClient's doc comment for why a
 *  container number alone can resolve to the wrong client's gate event). */
function gateFormIndex() {
  return stage3FormService.getGateFormIndexSync();
}

export async function getData(req, res) {
  const stage = parseInt(req.query.stage, 10);

  /* A STAGE-10 site delivery completes the Stage 2 transport leg and releases
     the container into Stage 3 — and Transportation has no status column of
     its own to fill, so Inspection/Billing's bypass gate (transportDone in
     getOffLeaseData) needs this signal too, not just Transportation/Gate In
     themselves: without it here, every container whose Transportation only
     ever completed via this delivery signal (the normal case — that column
     is "unfillable" by design) failed transportDone and vanished from the
     Inspection queue entirely, while the tab badge (getStageCounts, which
     always fetches this) still showed the correct count. Reads from cache,
     so fetching it for four stages instead of two costs nothing. */
  let deliveredKeys;
  if ([STAGE2_INTERNAL, STAGE3_INTERNAL, INSPECTION_INTERNAL, BILLING_INTERNAL].includes(stage)) {
    try {
      deliveredKeys = await stage8Service.getDeliveredKeys();
    } catch (e) {
      deliveredKeys = undefined;   // unresolvable -> queues behave as before
    }
  }

  /* Gate In (Stage 3) has no form left to fill its own status column, and
     Inspection (Stage 4) / Billing (Stage 5) both need to know its result —
     see offlease.service.js's getOffLeaseData doc comment. */
  const gfIndex = [STAGE3_INTERNAL, INSPECTION_INTERNAL, BILLING_INTERNAL].includes(stage)
    ? gateFormIndex()
    : undefined;

  const data = await offLeaseService.getOffLeaseData(stage, { deliveredKeys, gateFormIndex: gfIndex }, req.user);
  if (stage === STAGE2_INTERNAL) await stage8Service.enrichWithStage8Movements(data);

  /* TAT per row — how long this container has been waiting AT THIS STAGE
     against its budget. Additive: a failure must not cost the caller its list. */
  try {
    await offLeaseService.attachStageTat(data, stage);
  } catch (e) {
    console.error('[OL-TAT]', e?.message || e);
  }

  res.json(data);
}

/**
 * GET /api/offlease/stage-counts — pending count per stage, for the tab badges.
 *
 * Computed by running the SAME queue logic each tab uses, rather than counting
 * "current stage" from the dashboard: the two differ once the STAGE-10
 * delivery release is applied, and a badge that disagrees with the list it
 * labels is worse than no badge.
 */
export async function getStageCounts(req, res) {
  let deliveredKeys;
  try { deliveredKeys = await stage8Service.getDeliveredKeys(); } catch (e) { /* queues fall back */ }
  const gfIndex = gateFormIndex();

  const stages = offLeaseService.OL_ACTIVE_STAGE_NUMS;
  const counts = {};
  await Promise.all(stages.map(async (s) => {
    try {
      const d = await offLeaseService.getOffLeaseData(s, { deliveredKeys, gateFormIndex: gfIndex }, req.user);
      counts[s] = d.data.length;
    } catch (e) {
      counts[s] = null;   // null = unknown, so the tab shows no badge at all
    }
  }));

  try {
    counts.approval = (await offLeaseService.getOffLeaseApprovalData(req.user)).data.length;
  } catch (e) { counts.approval = null; }

  res.json({ counts });
}

export async function getStageDetail(req, res) {
  const stage = parseInt(req.params.stage, 10);
  const detail = await offLeaseService.getOffLeaseStageDetail(req.params.containerNo, stage, req.user);

  /* Billing Reconciliation needs the transport cost (STAGE-9 Freight Cost)
     and the inspection/repair estimate (Gate-In form's "Estimated repair
     budget") in front of the person reconciling — both are already fetched
     elsewhere in the app but never surfaced HERE, where the reconciliation
     actually happens, so this was manual lookup across two other screens.
     Best-effort: a read failure must not take the whole form down over a
     reference figure. */
  if (stage === BILLING_INTERNAL) {
    try {
      const fms = await stage8Service.getFmsForContainer(req.params.containerNo, detail.col_5);
      const freight = fms?.transport?.fields?.find(([label]) => /freight cost/i.test(label));
      detail._transportCost = freight ? freight[1] : null;
    } catch (e) { detail._transportCost = undefined; }

    try {
      const gf = stage3FormService.getGateFormForContainer(req.params.containerNo, detail.col_5);
      detail._inspectionCost = gf?.repairBudget ?? null;
    } catch (e) { detail._inspectionCost = undefined; }
  }

  res.json(detail);
}

export async function saveStage(req, res) {
  const stage = parseInt(req.params.stage, 10);
  // Permission for this stage (offlease1..offlease8) is checked inside the
  // service, since it's derived from the :stage route param at request time.
  const message = await offLeaseService.saveOffLeaseStage(req.params.containerNo, stage, req.body || {}, req.user.email);
  res.json({ message });
}

export async function nextLeaseId(req, res) {
  res.json({ leaseId: await offLeaseService.getNextLeaseId() });
}

/* ---- Pending Approval queue ---- */

export async function getApprovalData(req, res) {
  res.json(await offLeaseService.getOffLeaseApprovalData(req.user));
}

export async function saveApprovalAction(req, res) {
  const { status } = req.body;
  // Permission ('offleaseapproval') is checked inside the service.
  const message = await offLeaseService.saveOffLeaseApprovalAction(req.params.containerNo, status, req.user.email);
  res.json({ message });
}

/* ---- Dashboard container lookup ---- */

/** Proxy to the Accounts & Collection app — keeps its credentials server-side.
 *  `clientName` in the query string is caller-supplied and untrusted for
 *  access control (a scoped caller could put any name there) — visibility
 *  is decided from the container's OWN client name(s) on the Off-Lease/
 *  Deployed sheets, never from this parameter. See "Important Backend
 *  Requirement" in the 2026-08-20 user-wise client access request: a Sales
 *  login must not get another client's invoice/billing data even by editing
 *  request parameters. */
export async function getOutstanding(req, res) {
  const visible = await offLeaseService.isOffLeaseContainerVisibleToUser(req.params.containerNo, req.user);
  if (!visible) throw notFound(`Container not found: ${req.params.containerNo}`);

  const { getOutstandingForContainer } = await import('../services/accountsApi.service.js');
  const data = await getOutstandingForContainer(req.params.containerNo, req.query.clientName || '');

  /* Invoice files come from the Billing Sales sheet, keyed on invoice number —
     the Accounts API carries the money but not the document. Best-effort: the
     outstanding figures are the point of this endpoint and must still return
     if the sheet lookup fails. */
  try {
    const nos = (data.invoiceTotals || []).map((i) => i.invoiceNo);
    data.invoiceAttachments = await offLeaseService.getInvoiceAttachments(nos);
  } catch (e) {
    data.invoiceAttachments = {};
  }

  res.json(data);
}

export async function getContainerDetail(req, res) {
  // ?leaseId= picks one record when a container has been off-leased more than
  // once; without it the service returns the candidate list to choose from.
  const detail = await offLeaseService.getOffLeaseContainerDetail(req.params.containerNo, req.query.leaseId, req.user);

  /* Stage 9 movements are joined HERE rather than inside offlease.service so
     the two services keep pointing one way: stage9 reads offlease (for the
     Stage 2 pending list), never the reverse. Skipped while the caller is
     still choosing which record they mean, and best-effort — the history is
     an addition to the lookup, so a Stage 9 read failure must not take the
     whole container detail down with it. */
  if (detail?.found && !detail?.multiple) {
    try {
      detail.movements = await stage9Service.getMovementsForContainer(req.params.containerNo);
    } catch (e) {
      detail.movements = [];
      detail.movementsError = e?.message || 'Could not load Stage 9 movements';
    }

    /* Invoice attachments, looked up by invoice number rather than through the
       billing records — those are matched on container + client and come back
       empty for most containers. Best-effort, same as above. */
    try {
      const nos = (detail.outstanding?.invoiceTotals || []).map((i) => i.invoiceNo);
      detail.invoiceAttachments = await offLeaseService.getInvoiceAttachments(nos);
    } catch (e) {
      detail.invoiceAttachments = {};
    }

    /* The FMS chain (STAGE-8 movement, STAGE-9 transport, STAGE-10 site
       delivery) — the same data the Stage 2 grid shows, so the container's
       full history includes its transportation, not just the off-lease
       stages. Best-effort like the rest. */
    try {
      detail.fms = await stage8Service.getFmsForContainer(req.params.containerNo, detail.clientName);
    } catch (e) {
      detail.fms = null;
    }

    /* Stage 2 (internal 6) is COMPLETE once all three FMS legs exist — booked
       in STAGE-8, transported in STAGE-9, delivered in STAGE-10. The stage
       lists already release on this; without the same rule here the progress
       board and the container report still read "Pending" for a container the
       queues had long since moved on, which is the same fact told two ways.

       Applied to the response, not written to the sheet: Off-Lease Tracking
       currently has 212 columns where the code expects 289, so a positional
       write to a status column would land in the wrong place. `autoCompleted`
       marks it as derived rather than recorded. */
    /* Stage timers. Stage 1's clock starts when the container entered
       off-lease — its deployed date is the only recorded "arrived here"
       moment, so it seeds the first budget. */
    try {
      /* When the container was flagged Off-Lease on the Deployed sheet — not
         its deployed date, which is when it went OUT on lease and made every
         container read as a 600-day breach. */
      const entryStamp = await offLeaseService.getOffLeaseEntryStamp(req.params.containerNo);
      const sla = slaService.applySla(detail.stages || [], {
        entryStamp: entryStamp || detail.deployedDate,
        approvalStatus: detail.approvalStatus,
        approvalDate: detail.approvalDate
      });
      detail.approvalSla = sla.approvalSla;
      detail.delayedCount = sla.delayedCount;
      detail.anyDelayed = sla.anyDelayed;
    } catch (e) { /* timers are additive — never fail the lookup over them */ }

    const f = detail.fms;
    const s2 = (detail.stages || []).find((s) => s.stage === STAGE2_INTERNAL);
    if (f?.movement && f?.transport && f?.delivery && s2) {
      if (!s2.done) {
        s2.done = true;
        s2.status = 'Completed';
        s2.autoCompleted = true;
        s2.timestamp = f.transport.lastUpdated || f.movement.timestamp || '';
        s2.user = 'Auto — FMS Stage 8 · 9 · 10';
      }

      /* Transportation (internal 6) has no column of its own to fill either
         — same shape as Gate In, one step earlier in the workflow — so a
         container auto-completed here from the FMS chain showed "Completed"
         with "No fields recorded for this stage" in the container report's
         Filled Stage Data card, even though the data exists (and is already
         shown, grouped, in the Transportation (FMS) section above). Filled
         once, only when genuinely empty — never overwrites a real save. */
      if (!s2.fields?.length) {
        /* Rate/amount/cost columns dropped — system-wide convention, pricing
           is never shown outside Billing Reconciliation (see
           isRateOrAmountHeader's doc comment) — EXCEPT Freight Cost and
           Advance Amount specifically: asked for by name to be visible here
           too, alongside the rest of Stage 9's fields, not just on the
           Billing form's Cost Reference panel. */
        const COST_ALLOWLIST = /freight cost|advance amount/i;
        const fromRecord = (prefix, record) => (record?.fields || [])
          .filter(([label]) => COST_ALLOWLIST.test(label) || !isRateOrAmountHeader(label))
          .map(([label, value]) => ({ label: `${prefix}: ${label}`, value }))
          .filter((x) => x.value && String(x.value).trim() !== '');
        s2.fields = [
          ...fromRecord('Stage 8 (Movement)', f.movement),
          ...fromRecord('Stage 9 (Transport)', f.transport),
          ...fromRecord('Stage 10 (Delivery)', f.delivery)
        ];
      }
    }
  }

  res.json(detail);
}

export async function getDashboardData(req, res) {
  const data = await offLeaseService.getOffLeaseDashboardData(req.user);

  /* The STAGE-10 delivery release (Transportation has no status column left
     to fill, same shape as Gate In) is now applied INSIDE
     getOffLeaseDashboardData itself, inline with the Gate In / repair-skip
     bypasses — so a delivered container lands on its TRUE current stage in
     one pass. This used to be a post-hoc single-hop patch here (Stage 2 ->
     whatever's immediately next), which stranded a delivered+gated-in+
     repair-skipped container showing as "Gate In" when it had actually
     already reached Billing — the KPI card read 17 pending at Gate In while
     the tab itself only listed 3, the other 14 having moved on. */

  /* Live remarks are joined here, from ONE read of the remarks sheet, so the
     dashboard costs a constant two reads rather than one per record.
     Best-effort: a remarks failure must not take the whole pipeline view
     down, so every item still gets the field, just empty. */
  let index = {};
  try {
    index = await remarksService.getRemarkIndex();
  } catch (e) {
    data.remarksError = e?.message || 'Could not load remarks';
  }
  for (const it of data.items) {
    const hit = index[`${String(it.container).trim().toUpperCase()}::${String(it.leaseId).trim().toUpperCase()}`];
    it.remarkHtml = hit?.latest?.html || '';
    it.remarkText = hit?.latest?.text || '';
    it.remarkBy = hit?.latest?.enteredBy || '';
    it.remarkOn = hit?.latest?.timestamp || '';
    it.remarkCount = hit?.count || 0;
  }

  res.json(data);
}

/* ---- Dashboard live remarks ---- */

export async function getRemarkThread(req, res) {
  // Remarks are fetched by container number directly, not through a
  // pre-filtered list — a scoped caller could otherwise read another
  // client's remark thread just by guessing/typing a container number.
  const visible = await offLeaseService.isOffLeaseContainerVisibleToUser(req.params.containerNo, req.user);
  if (!visible) throw notFound(`Container not found: ${req.params.containerNo}`);

  res.json({ remarks: await remarksService.getRemarkThread(req.params.containerNo, req.query.leaseId) });
}

export async function addRemark(req, res) {
  // Permission (any off-lease stage) is checked inside the service.
  res.json(await remarksService.addOffLeaseRemark({
    containerNo: req.params.containerNo,
    leaseId: req.body?.leaseId,
    html: req.body?.html
  }, req.user.email));
}

export async function updateRemark(req, res) {
  // Ownership (author, or a roles admin) is enforced inside the service.
  res.json(await remarksService.updateOffLeaseRemark(req.params.remarkId, req.body?.html, req.user.email));
}

export async function deleteRemark(req, res) {
  res.json(await remarksService.deleteOffLeaseRemark(req.params.remarkId, req.user.email));
}

/* ---- Tracking-sheet bootstrap ---- */

export async function addToTracking(req, res) {
  const { containerNo } = req.body;
  const message = await offLeaseService.addToOffLeaseTracking(containerNo);
  res.json({ message });
}

/* ---- Stage 9: container movement log ---- */

export async function getMovementSources(req, res) {
  res.json({ containers: await stage9Service.getMovementSourceContainers() });
}

export async function getMovementSource(req, res) {
  res.json(await stage9Service.getMovementSourceContainer(req.params.containerNo));
}

export async function getMovements(req, res) {
  res.json(await stage9Service.getStage9Movements());
}

export async function saveMovement(req, res) {
  // Permission ('offlease9') is checked inside the service, as for the stages.
  res.json(await stage9Service.saveStage9Movement(req.body || {}, req.user.email));
}

/* ---- Admin-only: one-time maintenance / repair tools + diagnostics ---- */

export async function runCopyApprovedData(req, res) {
  assertRolesAdmin(req.user.email);
  await offLeaseService.copyApprovedData();
  res.json({ message: 'OK' });
}

export async function dumpHeaders(req, res) {
  assertRolesAdmin(req.user.email);
  res.json({ message: await offLeaseService.dumpOffLeaseTrackingHeaders() });
}

export async function restoreHeaderRow(req, res) {
  assertRolesAdmin(req.user.email);
  res.json({ message: await offLeaseService.restoreOffLeaseHeaderRowFromLatestBackup() });
}

export async function fixEmailCollision(req, res) {
  assertRolesAdmin(req.user.email);
  res.json({ message: await offLeaseService.fixQuotationEmailMarkedCollision() });
}

export async function reorderColumns(req, res) {
  assertRolesAdmin(req.user.email);
  res.json({ message: await offLeaseService.reorderOffLeaseTrackingColumns() });
}

export async function fixStageHeaders(req, res) {
  assertRolesAdmin(req.user.email);
  res.json({ message: await offLeaseService.fixOffLeaseStageHeaders() });
}

export async function debugOrderNos(req, res) {
  assertRolesAdmin(req.user.email);
  res.json({ message: await offLeaseService.debugOrderNosForContainer(req.params.containerNo) });
}

export async function traceOrder(req, res) {
  assertRolesAdmin(req.user.email);
  res.json({ message: await offLeaseService.traceOrderNo(req.params.containerNo) });
}

export async function feedsNewLeaseReff(req, res) {
  assertRolesAdmin(req.user.email);
  res.json({ message: await offLeaseService.whatFeedsNewLeaseReff() });
}

export async function feedsAllSheets(req, res) {
  assertRolesAdmin(req.user.email);
  res.json({ message: await offLeaseService.whatFeedsAllSheets() });
}
