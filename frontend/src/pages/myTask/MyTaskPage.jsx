import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader, Card, SearchBar, FilterBar, Pagination, StatCard, LoadingState, ErrorState, EmptyState } from '../../components/ui/index.js';
import { useAsync } from '../../hooks/useAsync.js';
import { usePagination } from '../../hooks/usePagination.js';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import { fetchMyTasks } from '../../services/myTask.service.js';
import { ROUTES } from '../../constants/routes.js';
import styles from './MyTaskPage.module.css';

/**
 * Field names below come straight off the real backend's getMyTasks()
 * (backend/src/services/tasks.service.js) — one GET /tasks/mine call
 * returns pending-work counts across the whole app; this page just renders
 * them as stat tiles, it does not own/compute any of the counting logic.
 *
 * `owner` mirrors CARD_OWNER in the original app's frontend/src/pages/myTask/
 * MyTaskPage.jsx (same names already used for the Off-Lease stage tabs, see
 * constants/stages.js) — cards with no dedicated owner there show none here
 * either. `path` makes each card clickable, same as the original.
 */
const GROUPS = {
  PENDING: 'Pending Actions',
  EXPIRY: 'Lease Expiry & Renewal',
  OFFLEASE: 'Off-Lease Stage Pipeline'
};

const CARD_DEFS = [
  { key: 'pendingVerify', label: 'Pending Verify', owner: 'Christopher', path: ROUTES.VERIFY_LEASE, group: GROUPS.PENDING, tint: 'warn', icon: 'clock' },
  { key: 'pendingApprovals', label: 'Pending Approvals', owner: 'Pushpa Maam', path: ROUTES.APPROVE_LEASE, group: GROUPS.PENDING, tint: 'warn', icon: 'clock' },
  { key: 'offleaseApproval', label: 'Off-Lease Pending Approval', owner: 'Pushpa Maam', path: ROUTES.OFF_LEASE, group: GROUPS.PENDING, tint: 'warn', icon: 'clock' },
  { key: 'expiring7', label: 'Expiring in 7 Days', path: ROUTES.LEASE_EXPIRY, group: GROUPS.EXPIRY, tint: 'warn', icon: 'alert' },
  { key: 'expired', label: 'Already Expired', path: ROUTES.LEASE_EXPIRY, group: GROUPS.EXPIRY, tint: 'error', icon: 'alert' },
  { key: 'renewPending', label: 'Renew Pending', path: ROUTES.RENEW_DOCUMENT, group: GROUPS.EXPIRY, tint: 'info', icon: 'edit' },
  /* Labels only, updated 2026-08-18 to match constants/stages.js's live
   * WORKFLOW order (1 Intimation, 2 Transportation, 3 Gate In, 4 Inspection,
   * 5 Billing, 6 FMS Closure) instead of the pre-reorder internal numbering
   * these had drifted to. Keys (olStage1..8) are untouched — they still
   * index getMyTasks()'s response 1:1 by internal stage number. */
  { key: 'olStage1', label: 'Off-Lease Stage 1: Intimation', owner: 'Christopher', path: ROUTES.OFF_LEASE, group: GROUPS.OFFLEASE, tint: 'info', icon: 'package' },
  { key: 'olStage2', label: 'Off-Lease (Retired) Lifting / Arrival', owner: 'Kshirod Khatua', path: ROUTES.OFF_LEASE, group: GROUPS.OFFLEASE, tint: 'info', icon: 'package' },
  { key: 'olStage3', label: 'Off-Lease Stage 4: Inspection Checklist', owner: 'Sitaram', path: ROUTES.OFF_LEASE, group: GROUPS.OFFLEASE, tint: 'info', icon: 'package' },
  { key: 'olStage4', label: 'Off-Lease (Retired) Quotation / Order', owner: 'Sitaram', path: ROUTES.OFF_LEASE, group: GROUPS.OFFLEASE, tint: 'info', icon: 'package' },
  { key: 'olStage5', label: 'Off-Lease Stage 5: Billing Reconciliation', owner: 'Shivani Maam', path: ROUTES.OFF_LEASE, group: GROUPS.OFFLEASE, tint: 'info', icon: 'package' },
  { key: 'olStage6', label: 'Off-Lease Stage 2: Transportation', owner: 'Kshirod Khatua', path: ROUTES.OFF_LEASE, group: GROUPS.OFFLEASE, tint: 'info', icon: 'package' },
  { key: 'olStage7', label: 'Off-Lease Stage 3: Gate In', owner: 'Pritam', path: ROUTES.OFF_LEASE, group: GROUPS.OFFLEASE, tint: 'info', icon: 'package' },
  { key: 'olStage8', label: 'Off-Lease Stage 6: FMS Closure', path: ROUTES.OFF_LEASE, group: GROUPS.OFFLEASE, tint: 'info', icon: 'package' }
];

const CATEGORY_OPTIONS = Object.values(GROUPS).map((g) => ({ value: g, label: g }));

function formatValue(def, raw) {
  const n = Number(raw) || 0;
  if (def.isCurrency) {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n);
  }
  return n.toLocaleString('en-IN');
}

export function MyTaskPage() {
  const { data, loading, error, reload } = useAsync(fetchMyTasks, []);
  const navigate = useNavigate();

  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const debouncedSearch = useDebouncedValue(search, 200);

  /* data.visibleKeys (backend/src/services/tasks.service.js's getMyTasks) is
     null for most users — show every card, unchanged. For a Sale-Person-scoped
     login (Gauri/Kedar/Sagar/Sapna today) it's the small set of cards that are
     actually theirs, so "Pending Verify (Christopher)" and every Off-Lease stage
     card — someone else's desk, not their lease work — don't show up here. */
  const tiles = useMemo(() => {
    const defs = data?.visibleKeys ? CARD_DEFS.filter((d) => data.visibleKeys.includes(d.key)) : CARD_DEFS;
    return defs.map((def) => ({ ...def, value: data ? data[def.key] : 0 }));
  }, [data]);

  const filtered = useMemo(() => {
    const t = debouncedSearch.trim().toLowerCase();
    return tiles.filter((tile) => {
      if (category && tile.group !== category) return false;
      if (t && !tile.label.toLowerCase().includes(t)) return false;
      return true;
    });
  }, [tiles, debouncedSearch, category]);

  const { page, totalPages, pageRows, setPage, nextPage, prevPage } = usePagination(filtered, 12);

  return (
    <>
      <PageHeader title="My Task" subtitle="Pending work counts across Lease Management, in one place" />

      <div className={styles.controls}>
        <SearchBar value={search} onChange={setSearch} placeholder="Search tasks…" />
        <FilterBar
          filters={[{
            key: 'group',
            label: 'Category',
            options: CATEGORY_OPTIONS,
            value: category,
            onChange: setCategory
          }]}
        />
      </div>

      <Card>
        {loading ? (
          <LoadingState label="Loading task counts…" />
        ) : error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : !filtered.length ? (
          <EmptyState message="No tasks match your search" />
        ) : (
          <>
            <div className={styles.grid}>
              {pageRows.map((tile) => (
                <StatCard
                  key={tile.key}
                  icon={tile.icon}
                  tint={tile.tint}
                  label={tile.owner ? `${tile.label} (${tile.owner})` : tile.label}
                  value={formatValue(tile, tile.value)}
                  footnote={tile.value > 0 ? 'Click to open →' : 'All clear'}
                  onClick={tile.path ? () => navigate(tile.path) : undefined}
                />
              ))}
            </div>
            <div className={styles.paginationWrap}>
              <Pagination page={page} totalPages={totalPages} onPrev={prevPage} onNext={nextPage} onPage={setPage} />
            </div>
          </>
        )}
      </Card>
    </>
  );
}
