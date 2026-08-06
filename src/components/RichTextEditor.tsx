import React, { useRef, useEffect } from 'react';
import { sanitizeRichTextHtml } from '../domain/richTextSanitizer';
import { insertHtmlAtSelection, insertTextAtSelection } from '../utils/richTextSelection';

interface RichTextEditorProps {
  html: string;
  onChange: (html: string) => void;
  onFocus?: () => void;
  placeholder?: string;
  className?: string;
  testId?: string;
  autoFocus?: boolean;
  enableChecklist?: boolean;
}

export default function RichTextEditor({
  html,
  onChange,
  onFocus,
  placeholder,
  className,
  testId,
  autoFocus = false,
  enableChecklist = false,
}: RichTextEditorProps) {
  const contentEditableRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const sanitized = sanitizeRichTextHtml(html);
    if (contentEditableRef.current && contentEditableRef.current.innerHTML !== sanitized) {
      contentEditableRef.current.innerHTML = sanitized;
    }
  }, [html]);

  useEffect(() => {
    if (!autoFocus) return;
    const frame = window.requestAnimationFrame(() => contentEditableRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [autoFocus]);

  const handleInput = (e: React.FormEvent<HTMLDivElement>) => {
    if (enableChecklist) {
      e.currentTarget.querySelectorAll('ul[data-checklist="true"] > li').forEach((item) => {
        if (!item.hasAttribute('data-checked')) item.setAttribute('data-checked', 'false');
      });
    }
    onChange(sanitizeRichTextHtml(e.currentTarget.innerHTML));
  };

  const insertChecklist = () => {
    const root = contentEditableRef.current;
    if (!root) return;
    const selection = window.getSelection();
    let range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    const list = document.createElement('ul');
    list.setAttribute('data-checklist', 'true');
    const item = document.createElement('li');
    item.setAttribute('data-checked', 'false');
    item.append(document.createElement('br'));
    list.append(item);

    if (range && root.contains(range.commonAncestorContainer)) {
      range.deleteContents();
      range.insertNode(list);
    } else {
      root.append(list);
    }

    root.focus();
    const caret = document.createRange();
    caret.selectNodeContents(item);
    caret.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(caret);
    onChange(sanitizeRichTextHtml(root.innerHTML));
  };

  const handleChecklistPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!enableChecklist) return;
    const element = event.target instanceof Element ? event.target : null;
    const item = element?.closest<HTMLElement>('ul[data-checklist="true"] > li[data-checked]');
    if (!item || event.clientX - item.getBoundingClientRect().left > 30) return;
    event.preventDefault();
    item.setAttribute('data-checked', item.dataset.checked === 'true' ? 'false' : 'true');
    onChange(sanitizeRichTextHtml(event.currentTarget.innerHTML));
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    const htmlContent = e.clipboardData.getData('text/html');
    const textContent = e.clipboardData.getData('text/plain');
    const pasted = htmlContent || textContent;
    if (!pasted) return;
    if (htmlContent) insertHtmlAtSelection(sanitizeRichTextHtml(htmlContent));
    else insertTextAtSelection(textContent);
  };

  return (
    <>
      {enableChecklist && (
        <div className="quick-note-tools" aria-label="Note tools">
          <button
            type="button"
            onPointerDown={(event) => {
              event.preventDefault();
              insertChecklist();
            }}
            className="quick-note-checklist-button"
            aria-label="Add checklist item"
            title="Add checklist item"
          >
            <span className="quick-note-checkbox-icon" aria-hidden="true" />
            Checklist
          </button>
        </div>
      )}
      <div
        ref={contentEditableRef}
        contentEditable
        onInput={handleInput}
        onPaste={handlePaste}
        onFocus={onFocus}
        onPointerDown={handleChecklistPointerDown}
        className={`focus:outline-none focus:ring-0 empty:before:content-[attr(data-placeholder)] empty:before:text-brand-plum/40 ${className}`}
        data-placeholder={placeholder}
        data-testid={testId}
        suppressContentEditableWarning
      />
    </>
  );
}
