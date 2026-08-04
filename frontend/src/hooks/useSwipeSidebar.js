import { useRef } from 'react';

const EDGE_ZONE = 40; // px from the left edge a swipe-to-open gesture must start within
const MIN_DISTANCE = 50; // px of horizontal travel before a touch counts as a swipe, not a tap

/**
 * Touch-swipe open/close for the mobile sidebar drawer: swipe left-to-right
 * starting near the left edge opens it, swipe right-to-left anywhere closes
 * it — the same convention as most native app drawers. Returns handlers to
 * spread onto the swipeable container (the shell root).
 */
export function useSwipeSidebar(open, setOpen) {
  const touch = useRef({ x: 0, y: 0, active: false });

  function onTouchStart(e) {
    const t = e.touches[0];
    touch.current = { x: t.clientX, y: t.clientY, active: true };
  }

  function onTouchEnd(e) {
    if (!touch.current.active) return;
    touch.current.active = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - touch.current.x;
    const dy = t.clientY - touch.current.y;

    if (Math.abs(dx) < MIN_DISTANCE || Math.abs(dx) < Math.abs(dy) * 1.5) return; // not a clear horizontal swipe

    if (!open && dx > 0 && touch.current.x < EDGE_ZONE) setOpen(true);
    else if (open && dx < 0) setOpen(false);
  }

  return { onTouchStart, onTouchEnd };
}
