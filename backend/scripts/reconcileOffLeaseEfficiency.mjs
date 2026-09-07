/**
 * OFF-LEASE EFFICIENCY — REAL-DATA VALIDATION + DATA QUALITY REPORT
 *
 * Run manually: node scripts/reconcileOffLeaseEfficiency.mjs
 * (from the backend/ directory — not part of the app's runtime.)
 *
 * NOTE ON "OLD VS NEW": the spec asked for an old-vs-new numeric diff. That
 * comparison isn't meaningful here — the OLD system computed "Overdue %"
 * (% of records that ran late against a calibrated/fixed budget) and the
 * NEW system computes "Efficiency %" (Target/Actual × 100, capped at 100%).
 * These are two different metrics with incomparable units (e.g. "48%
 * overdue" and "0.36% efficiency" are not the same number measured two
 * ways) — the whole point of today's rebuild was to REPLACE the metric, not
 * patch a bug in the same formula. What IS directly comparable, and what
 * this script reports instead, is every case where the NEW engine's own
 * stricter rules changed a record's classification versus what the OLD
 * system would have silently done with the exact same source data:
 *
 *   - OLD: a negative ("backdated") raw duration was clamped to 0 and shown
 *     as a clean "Completed" (100%-looking, no visible problem).
 *     NEW: reported as INVALID_DATA with the reason stated outright.
 *   - OLD: Gate In had no real stop signal at all (a since-fixed same-day
 *     bug, unrelated to this rebuild) — not reconcilable as "old formula"
 *     since it was already corrected before this rebuild started.
 *
 * This script prints those reclassified cases explicitly, then the full
 * data-quality report (spec §24 format) computed by the engine itself.
 */
import { connectMongo } from '../src/config/db.js';
import { getOffLeaseEfficiencyReport } from '../src/services/offleaseEfficiency.service.js';

function fmtPct(p) { return p == null ? '—' : `${p}%`; }

async function main() {
  await connectMongo();
  const report = await getOffLeaseEfficiencyReport(null);

  console.log('\n=== OVERALL ===');
  console.log(JSON.stringify(report.overall, null, 2));

  console.log('\n=== STAGE-WISE ===');
  for (const s of report.stages) {
    console.log(`${s.stageName.padEnd(28)} target=${s.targetDurationMinutes}min  avgActual=${s.avgActualDurationMinutes ?? '—'}min  efficiency=${fmtPct(s.efficiencyPercentage)}  completed=${s.completedCount} pending=${s.pendingCount} hold=${s.onHoldCount} rework=${s.reworkCount} n/a=${s.notApplicableCount} missing=${s.missingDataCount}`);
  }

  console.log('\n=== RECLASSIFIED CASES (would have silently clamped to 0 / shown "Completed" under the old backdated-clamp behavior; now explicit INVALID_DATA) ===');
  let reclassified = 0;
  for (const c of report.containers) {
    for (const s of c.stages) {
      if (s.calculationStatus === 'INVALID_DATA') {
        reclassified++;
        console.log(`  ${c.containerNo.padEnd(14)} ${s.stageName.padEnd(24)} ${s.reason}`);
      }
    }
  }
  console.log(`  Total: ${reclassified} stage-records reclassified from "silently 0 / Completed" to INVALID_DATA.`);

  console.log('\n=== MISSING_DATA CASES ===');
  let missing = 0;
  for (const c of report.containers) {
    for (const s of c.stages) {
      if (s.calculationStatus === 'MISSING_DATA') {
        missing++;
        console.log(`  ${c.containerNo.padEnd(14)} ${s.stageName.padEnd(24)} ${s.reason}`);
      }
    }
  }
  console.log(`  Total: ${missing} stage-records.`);

  console.log('\n=== DATA QUALITY REPORT ===');
  console.log(`Total Records:                  ${report.dataQuality.totalRecords}`);
  console.log(`Valid Efficiency Records:       ${report.dataQuality.validEfficiencyRecords}`);
  console.log(`Missing Timestamp Records:      ${report.dataQuality.missingTimestampRecords}`);
  console.log(`Invalid Timestamp Records:      ${report.dataQuality.invalidTimestampRecords}`);
  console.log(`Not Applicable Records:         ${report.dataQuality.notApplicableRecords}`);
  console.log(`Rework Records (Move-To-Stage): ${report.dataQuality.reworkRecords}`);
  console.log(`Hold Records:                   ${report.dataQuality.holdRecords}`);
  console.log(`Records Requiring Manual Review:${report.dataQuality.recordsRequiringManualReview}`);
  console.log('\nKnown limitations:');
  for (const l of report.dataQuality.knownLimitations) console.log(`  - ${l}`);

  console.log('\n=== WORST 10 CONTAINERS BY CUMULATIVE EFFICIENCY (VALID only) ===');
  const ranked = report.containers
    .filter((c) => c.cumulative.calculationStatus === 'VALID')
    .sort((a, b) => a.cumulative.cumulativeEfficiencyPercentage - b.cumulative.cumulativeEfficiencyPercentage)
    .slice(0, 10);
  for (const c of ranked) {
    console.log(`  ${c.containerNo.padEnd(14)} ${fmtPct(c.cumulative.cumulativeEfficiencyPercentage).padEnd(8)} target=${c.cumulative.totalTargetMinutes}min actual=${c.cumulative.totalActualMinutes}min  currentStage=${c.currentStage}`);
  }

  process.exit(0);
}

main().catch((e) => { console.error('RECONCILIATION FAILED:', e); process.exit(1); });
