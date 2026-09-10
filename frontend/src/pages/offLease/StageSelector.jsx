import { useEffect, useState } from 'react';
import { buildFilledStages } from './lookupModel.js';
import styles from './LookupResult.module.css';

/**
 * Which completed stages a lookup result's PDF download should include —
 * defaults to every stage selected, and resets to "all selected" whenever a
 * new result comes in (a fresh search or a different container opened).
 * Explicit request 2026-09-09: "each stage select then download pdf" (e.g.
 * leave a stage out of the report).
 */
export function useStageSelection(result) {
  const filled = result?.found && !result?.multiple ? buildFilledStages(result) : [];
  const [selected, setSelected] = useState(() => new Set(filled.map((s) => s.internalStage)));

  useEffect(() => {
    setSelected(new Set(filled.map((s) => s.internalStage)));
    // Only the identity of `result` should reset the selection — recomputing
    // `filled` every render must not itself trigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  const toggle = (internalStage) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(internalStage)) next.delete(internalStage); else next.add(internalStage);
    return next;
  });

  return { filled, selected, toggle };
}

/** Checkbox row, one per completed stage — unchecking a stage excludes it
 *  from the next PDF download only (the on-screen "Filled Stage Data" cards
 *  and the Excel download are unaffected). */
export function StageSelector({ filled, selected, onToggle }) {
  if (!filled.length) return null;
  return (
    <div className={styles.stageSelectorRow}>
      <span className={styles.stageSelectorLabel}>Include in PDF</span>
      {filled.map((s) => (
        <label key={s.internalStage} className={styles.stageSelectorItem}>
          <input
            type="checkbox"
            checked={selected.has(s.internalStage)}
            onChange={() => onToggle(s.internalStage)}
          />
          {s.retired ? 'Retired' : `Stage ${s.stage}`} · {s.label}
        </label>
      ))}
    </div>
  );
}
