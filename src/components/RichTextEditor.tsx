import React, { useRef, useEffect } from 'react';

interface RichTextEditorProps {
  html: string;
  onChange: (html: string) => void;
  onFocus?: () => void;
  placeholder?: string;
  className?: string;
}

export default function RichTextEditor({ html, onChange, onFocus, placeholder, className }: RichTextEditorProps) {
  const contentEditableRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (contentEditableRef.current && contentEditableRef.current.innerHTML !== html) {
      contentEditableRef.current.innerHTML = html;
    }
  }, [html]);

  const handleInput = (e: React.FormEvent<HTMLDivElement>) => {
    onChange(e.currentTarget.innerHTML);
  };

  return (
    <div
      ref={contentEditableRef}
      contentEditable
      onInput={handleInput}
      onFocus={onFocus}
      className={`focus:outline-none focus:ring-0 empty:before:content-[attr(data-placeholder)] empty:before:text-brand-plum/40 ${className}`}
      data-placeholder={placeholder}
      suppressContentEditableWarning
    />
  );
}
