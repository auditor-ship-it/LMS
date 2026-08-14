/**
 * Locked icon set, ported 1:1 from crystal-design-system.html's sprite —
 * outline only, 1.7px stroke, 24px viewBox, round caps/joins. Rendered once
 * near the app root; every <Icon name="…"/> just references a symbol here.
 * Only the subset this app actually uses — add more from the design system
 * file as new icons are needed, never invent one that isn't in it.
 */
export function IconSprite() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
      <defs>
        <symbol id="i-home" viewBox="0 0 24 24"><path d="M3 10.5 12 3l9 7.5" /><path d="M5.5 9.5V20h13V9.5" /><path d="M9.5 20v-6h5v6" /></symbol>
        <symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /></symbol>
        <symbol id="i-pin" viewBox="0 0 24 24"><path d="M12 21.5s6.5-6.4 6.5-11.5a6.5 6.5 0 0 0-13 0c0 5.1 6.5 11.5 6.5 11.5z" /><circle cx="12" cy="10" r="2.4" /></symbol>
        <symbol id="i-filter" viewBox="0 0 24 24"><path d="M3.5 5.5h17l-6.5 8v6l-4 2v-8z" /></symbol>
        <symbol id="i-check" viewBox="0 0 24 24"><path d="M4.5 12.5 9.5 17.5 19.5 6.5" /></symbol>
        <symbol id="i-check-circle" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" /><path d="M8 12.2l2.8 2.8L16 9.5" /></symbol>
        <symbol id="i-x" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></symbol>
        <symbol id="i-x-circle" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" /><path d="M9.2 9.2l5.6 5.6M14.8 9.2l-5.6 5.6" /></symbol>
        <symbol id="i-alert" viewBox="0 0 24 24"><path d="M12 4 2.8 20h18.4z" /><path d="M12 10v4.5M12 17.3v.2" /></symbol>
        <symbol id="i-info" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5.5M12 7.8v.2" /></symbol>
        <symbol id="i-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5.2l3.2 2" /></symbol>
        <symbol id="i-edit" viewBox="0 0 24 24"><path d="M4.5 19.5h4l10-10-4-4-10 10z" /><path d="M14.5 5.5l4 4" /></symbol>
        <symbol id="i-package" viewBox="0 0 24 24"><path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5z" /><path d="M3.5 7.5 12 12l8.5-4.5M12 12v9" /></symbol>
        <symbol id="i-grid" viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.5" /></symbol>
        <symbol id="i-list" viewBox="0 0 24 24"><path d="M4 6.5h16M4 12h16M4 17.5h16" /></symbol>
        <symbol id="i-inbox" viewBox="0 0 24 24"><path d="M3.5 13.5h5l1.5 3h4l1.5-3h5" /><path d="M5.6 4.5h12.8l3.1 9v6.5a1.5 1.5 0 0 1-1.5 1.5H4a1.5 1.5 0 0 1-1.5-1.5V13.5z" /></symbol>
        <symbol id="i-container" viewBox="0 0 24 24"><rect x="2.5" y="7" width="19" height="10" rx="1.2" /><path d="M6 7v10M9.5 7v10M13 7v10M16.5 7v10" /></symbol>
        <symbol id="i-chev-down" viewBox="0 0 24 24"><path d="M6 9.5l6 6 6-6" /></symbol>
        <symbol id="i-chev-up" viewBox="0 0 24 24"><path d="M6 14.5l6-6 6 6" /></symbol>
        <symbol id="i-chev-left" viewBox="0 0 24 24"><path d="M14.5 6l-6 6 6 6" /></symbol>
        <symbol id="i-chev-right" viewBox="0 0 24 24"><path d="M9.5 6l6 6-6 6" /></symbol>
        <symbol id="i-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></symbol>
        <symbol id="i-more" viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="12" cy="19" r="1.4" /></symbol>
        <symbol id="i-trash" viewBox="0 0 24 24"><path d="M4.5 6.5h15M9 6.5V4.2h6v2.3M6.5 6.5 7.5 21h9l1-14.5M10.5 10v7M13.5 10v7" /></symbol>
        <symbol id="i-refresh" viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.6-5.9" /><path d="M20 3.5V8h-4.5" /></symbol>
        <symbol id="i-eye" viewBox="0 0 24 24"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.8" /></symbol>
        <symbol id="i-download" viewBox="0 0 24 24"><path d="M12 3.5v11M12 14.5 8 10.5M12 14.5l4-4M4.5 17v3.5h15V17" /></symbol>
        <symbol id="i-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.2" /><path d="M12 2.5v3M12 18.5v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2.5 12h3M18.5 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" /></symbol>
        <symbol id="i-moon" viewBox="0 0 24 24"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z" /></symbol>
        <symbol id="i-lock" viewBox="0 0 24 24"><rect x="4.5" y="10.5" width="15" height="10" rx="2" /><path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7" /></symbol>
      </defs>
    </svg>
  );
}
