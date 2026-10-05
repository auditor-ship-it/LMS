import { NAV_TREE } from '../constants/nav.js';

/** Flattens NAV_TREE into path -> trail (array of labels from root to that page). */
function buildPathMap() {
  const map = {};
  for (const item of NAV_TREE.items) {
    if (item.children) {
      for (const child of item.children) {
        map[child.path] = [NAV_TREE.label, item.label, child.label];
      }
    } else if (item.path) {
      map[item.path] = [NAV_TREE.label, item.label];
    }
  }
  return map;
}

const PATH_MAP = buildPathMap();

const SUBPAGE_LABELS = { record: 'Record' };

export function trailFor(pathname) {
  if (PATH_MAP[pathname]) return PATH_MAP[pathname];
  /* A sub-page (e.g. /off-lease/record) trails off its parent's crumbs. */
  const parent = Object.keys(PATH_MAP).filter((p) => pathname.startsWith(`${p}/`)).sort((a, b) => b.length - a.length)[0];
  if (parent) return [...PATH_MAP[parent], SUBPAGE_LABELS[pathname.slice(parent.length + 1)] || 'Details'];
  return [NAV_TREE.label];
}
