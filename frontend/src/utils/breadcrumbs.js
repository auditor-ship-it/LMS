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

export function trailFor(pathname) {
  return PATH_MAP[pathname] || [NAV_TREE.label];
}
