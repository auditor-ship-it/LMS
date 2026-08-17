import * as offLeaseService from '../services/offlease.service.js';
import * as stage9Service from '../services/stage9.service.js';
import * as remarksService from '../services/offleaseRemarks.service.js';
import * as stage8Service from '../services/stage8.service.js';
import * as slaService from '../services/offleaseSla.service.js';
import { assertRolesAdmin } from '../services/roles.service.js';

/* ---- Core 8-stage pipeline ---- */

/** Internal stage 6 — the tab shown as "Stage 2 (Transportation)". Read-only,
 *  and the only stage enriched from the external FMS STAGE-8 sheet. */
const STAGE2_INTERNAL = 6;

/** Internal stage 7 — the tab shown as "Stage 3 (Gate In)". */
const STAGE3_INTERNAL = 7;

export async function getData(req, res) {
  const stage = parseInt(req.query.stage, 10);

  /* A STAGE-10 site delivery completes the Stage 2 transport leg and releases
     the container into Stage 3. Only those two queues need the lookup, and it
     reads from cache so it costs nothing. */
  let deliveredKeys;
  if (stage === STAGE2_INTERNAL || stage === STAGE3_INTERNAL) {
    try {
      deliveredKeys = await stage8Service.getDeliveredKeys();
    } catch (e) {
      deliveredKeys = undefined;   // unresolvable -> queues behave as before
    }
  }

  const data = await offLeaseService.getOffLeaseData(stage, { deliveredKeys });
  if (stage === STAGE2_INTERNAL) await stage8Service.enrichWithStage8Movements(data);
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

  const stages = offLeaseService.OL_ACTIVE_STAGE_NUMS;
  const counts = {};
  await Promise.all(stages.map(async (s) => {
    try {
      const d = await offLeaseService.getOffLeaseData(s, { deliveredKeys });
      counts[s] = d.data.length;
    } catch (e) {
      counts[s] = null;   // null = unknown, so the tab shows no badge at all
    }
  }));

  try {
    counts.approval = (await offLeaseService.getOffLeaseApprovalData()).data.length;
  } catch (e) { counts.approval = null; }

  res.json({ counts });
}

export async function getStageDetail(req, res) {
  const stage = parseInt(req.params.stage, 10);
  res.json(await offLeaseService.getOffLeaseStageDetail(req.params.containerNo, stage));
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
  res.json(await offLeaseService.getOffLeaseApprovalData());
}

export async function saveApprovalAction(req, res) {
  const { status } = req.body;
  // Permission ('offleaseapproval') is checked inside the service.
  const message = await offLeaseService.saveOffLeaseApprovalAction(req.params.containerNo, status, req.user.email);
  res.json({ message });
}

/* ---- Dashboard container lookup ---- */

/** Proxy to the Accounts & Collection app — keeps its credentials server-side. */
export async function getOutstanding(req, res) {
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
  const detail = await offLeaseService.getOffLeaseContainerDetail(req.params.containerNo, req.query.leaseId);

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
    if (f?.movement && f?.transport && f?.delivery) {
      const s2 = (detail.stages || []).find((s) => s.stage === STAGE2_INTERNAL);
      if (s2 && !s2.done) {
        s2.done = true;
        s2.status = 'Completed';
        s2.autoCompleted = true;
        s2.timestamp = f.transport.lastUpdated || f.movement.timestamp || '';
        s2.user = 'Auto — FMS Stage 8 · 9 · 10';
      }
    }
  }

  res.json(detail);
}

export async function getDashboardData(req, res) {
  const data = await offLeaseService.getOffLeaseDashboardData();

  /* Apply the same FMS release the stage queues use. The dashboard classifies
     purely from the sheet's status columns, so a container the queues had
     already moved to Gate In still showed as sitting at Transportation — the
     KPI card read 0 while the Stage 3 tab listed 9. */
  try {
    const delivered = await stage8Service.getDeliveredKeys();
    if (delivered.size) {
      const norm = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      for (const it of data.items) {
        if (it.currentStageNum !== STAGE2_INTERNAL) continue;
        if (!delivered.has(norm(it.container))) continue;

        /* Stage 2 is done, so the container now sits at the next stage in the
           workflow — read off its own stages array rather than hard-coding, so
           this survives another reordering. */
        const order = (it.stages || []).map((s) => s.stage);
        const next = order[order.indexOf(STAGE2_INTERNAL) + 1];
        const s = (it.stages || []).find((x) => x.stage === next);
        if (!s) continue;

        const s2 = (it.stages || []).find((x) => x.stage === STAGE2_INTERNAL);
        if (s2) { s2.done = true; s2.autoCompleted = true; }
        it.currentStageNum = next;
        it.currentStage = `Stage ${s.displayStage} · ${s.label}`;

        if (data.kpis?.byStage) {
          data.kpis.byStage[STAGE2_INTERNAL] = Math.max(0, (data.kpis.byStage[STAGE2_INTERNAL] || 0) - 1);
          data.kpis.byStage[next] = (data.kpis.byStage[next] || 0) + 1;
        }
      }
    }
  } catch (e) { /* FMS unavailable -> dashboard falls back to sheet status */ }

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
