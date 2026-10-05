const SPECIAL = '\\^$.*+?()[]{}|';
const escapeRegExp = (w) => Array.from(w, (ch) => (SPECIAL.includes(ch) ? `\\${ch}` : ch)).join('');

/**
 * Wraps every occurrence of the search words inside `text` in <mark>, so a row
 * shows WHY it matched. Case-insensitive; the words are the same
 * whitespace-separated ones the dashboard filter uses, so what is highlighted
 * is exactly what was matched. No query -> the text, untouched.
 */
export function Highlight({ text, query }) {
  const value = text == null ? '' : String(text);
  const words = String(query || '').trim().split(/\s+/).filter(Boolean);
  if (!value || !words.length) return value;

  const pattern = new RegExp(`(${words.map(escapeRegExp).join('|')})`, 'gi');
  // split() with one capture group puts the matches at the odd indexes.
  return value.split(pattern).map((part, i) => (
    i % 2 === 1
      ? <mark key={i} style={{ background: 'var(--amber-c, #ffd54a)', color: 'inherit', borderRadius: 2, padding: '0 1px' }}>{part}</mark>
      : part
  ));
}
