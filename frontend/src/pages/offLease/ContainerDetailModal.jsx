import { Modal, LoadingState, ErrorState, Button } from '../../components/ui/index.js';
import { useAsync } from '../../hooks/useAsync.js';
import { lookupContainer } from '../../services/offLease.service.js';
import { exportLookupToExcel, exportLookupToPdf } from './lookupExport.js';
import { LookupResult } from './LookupResult.jsx';
import { useStageSelection, StageSelector } from './StageSelector.jsx';

/**
 * Every stage's data for one record, opened by clicking a dashboard row.
 *
 * Deliberately renders <LookupResult> — the SAME component Container Lookup
 * uses — rather than a second layout: it already shows the Stage 1 to Stage 9
 * history table, the movements, the progress board and each completed stage's
 * fields and checklists. A parallel implementation would be one more place for
 * a newly captured field to go missing.
 *
 * `leaseId` is passed through because a container can be off-leased under more
 * than one lease; without it the API returns the candidate list rather than
 * this row's record.
 */
export function ContainerDetailModal({ container, leaseId, onClose }) {
  const { data, loading, error, reload } = useAsync(
    () => lookupContainer(container, leaseId),
    [container, leaseId]
  );

  const ready = data?.found && !data?.multiple;
  const { filled, selected, toggle } = useStageSelection(data);

  return (
    <Modal
      open
      onClose={onClose}
      width="1100px"
      title={`${container}${leaseId ? ` · ${leaseId}` : ''} — all stage data`}
    >
      {loading && <LoadingState label="Loading stage data…" />}
      {!loading && error && <ErrorState message={error} onRetry={reload} />}
      {!loading && !error && data && !data.found && (
        <ErrorState message={data.message || 'No off-lease record found for this container'} />
      )}

      {!loading && !error && ready && (
        <>
          <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            <StageSelector filled={filled} selected={selected} onToggle={toggle} />
            <Button variant="secondary" size="sm" onClick={() => exportLookupToExcel(data)}>Download Excel</Button>
            <Button variant="secondary" size="sm" onClick={() => exportLookupToPdf(data, selected)}>Download PDF</Button>
          </div>
          <LookupResult result={data} />
        </>
      )}
    </Modal>
  );
}
