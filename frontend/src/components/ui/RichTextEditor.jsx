import { useEffect, useRef } from 'react';
import styles from './RichTextEditor.module.css';

/**
 * Small rich-text editor — bold / italic / underline / bullet / numbered list.
 *
 * Built on contentEditable with no third-party dependency: the app has to run
 * offline against its own bundle, and a full editor package would be orders of
 * magnitude larger than the handful of inline formats a comment needs.
 *
 * document.execCommand is formally deprecated but is still the only API every
 * browser implements for this, and has no removal date — the alternative is
 * hand-writing Range/Selection surgery for each format, which is far more code
 * and far more ways to corrupt a selection.
 *
 * SECURITY: whatever this produces is sanitised again on the server before
 * storage (offleaseRemarks.service.js). Nothing here is a security boundary —
 * a user can paste any HTML into a contentEditable, so the client cannot be
 * the thing that decides what is safe.
 */

const TOOLS = [
  { cmd: 'bold', label: 'B', title: 'Bold', className: 'toolBold' },
  { cmd: 'italic', label: 'I', title: 'Italic', className: 'toolItalic' },
  { cmd: 'underline', label: 'U', title: 'Underline', className: 'toolUnderline' },
  { cmd: 'insertUnorderedList', label: '••', title: 'Bulleted list' },
  { cmd: 'insertOrderedList', label: '1.', title: 'Numbered list' }
];

export function RichTextEditor({ value, onChange, placeholder, disabled, autoFocus }) {
  const ref = useRef(null);

  /* Written into the DOM only when the incoming value differs from what is
     already there. Binding it every render would reset the caret to the start
     on each keystroke, because React does not control contentEditable's
     children. */
  useEffect(() => {
    const el = ref.current;
    if (el && value !== el.innerHTML) el.innerHTML = value || '';
  }, [value]);

  useEffect(() => { if (autoFocus) ref.current?.focus(); }, [autoFocus]);

  const exec = (cmd) => {
    ref.current?.focus();
    document.execCommand(cmd, false, null);
    onChange?.(ref.current?.innerHTML || '');
  };

  /* Paste as plain text: pasting from Word or a browser carries a payload of
     styles, fonts and classes that would survive into the stored remark and
     render inconsistently everywhere it is shown. */
  const onPaste = (e) => {
    e.preventDefault();
    const text = e.clipboardData?.getData('text/plain') || '';
    document.execCommand('insertText', false, text);
  };

  return (
    <div className={`${styles.wrap} ${disabled ? styles.disabled : ''}`}>
      <div className={styles.toolbar}>
        {TOOLS.map((t) => (
          <button
            key={t.cmd}
            type="button"
            className={`${styles.tool} ${t.className ? styles[t.className] : ''}`}
            title={t.title}
            aria-label={t.title}
            disabled={disabled}
            // onMouseDown, not onClick: clicking a button blurs the editable
            // area first, and the browser drops the selection the command needs.
            onMouseDown={(e) => { e.preventDefault(); exec(t.cmd); }}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div
        ref={ref}
        className={styles.editor}
        contentEditable={!disabled}
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={placeholder || 'Remark'}
        data-placeholder={placeholder || ''}
        onInput={(e) => onChange?.(e.currentTarget.innerHTML)}
        onPaste={onPaste}
      />
    </div>
  );
}
