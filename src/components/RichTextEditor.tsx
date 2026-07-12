import React, { useRef, useEffect } from 'react';
import { sanitizeRichTextHtml } from '../domain/richTextSanitizer';

interface RichTextEditorProps {
  html: string;
  onChange: (html: string) => void;
  onFocus?: () => void;
  placeholder?: string;
  className?: string;
  testId?: string;
}

export default function RichTextEditor({ html, onChange, onFocus, placeholder, className, testId }: RichTextEditorProps) {
  const contentEditableRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const sanitized = sanitizeRichTextHtml(html);
    if (contentEditableRef.current && contentEditableRef.current.innerHTML !== sanitized) {
      contentEditableRef.current.innerHTML = sanitized;
    }
  }, [html]);

  const handleInput = (e: React.FormEvent<HTMLDivElement>) => {
    onChange(sanitizeRichTextHtml(e.currentTarget.innerHTML));
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    const htmlContent = e.clipboardData.getData('text/html');
    const textContent = e.clipboardData.getData('text/plain');
    const pasted = htmlContent || textContent;
    if (!pasted) return;
    document.execCommand(
      htmlContent ? 'insertHTML' : 'insertText',
      false,
      htmlContent ? sanitizeRichTextHtml(htmlContent) : textContent,
    );
  };

  return (
    <div
      ref={contentEditableRef}
      contentEditable
      onInput={handleInput}
      onPaste={handlePaste}
      onFocus={onFocus}
      className={`focus:outline-none focus:ring-0 empty:before:content-[attr(data-placeholder)] empty:before:text-brand-plum/40 ${className}`}
      data-placeholder={placeholder}
      data-testid={testId}
      suppressContentEditableWarning
    />
  );
}
