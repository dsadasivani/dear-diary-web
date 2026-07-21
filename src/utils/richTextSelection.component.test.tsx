import { beforeEach, describe, expect, it } from 'vitest';
import {
  getActiveRichTextFormats,
  insertTextAtSelection,
  toggleInlineFormat,
  toggleUnorderedList,
} from './richTextSelection';

describe('selection-based rich text commands', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div contenteditable="true">hello world</div>';
  });

  const select = (start: number, end: number) => {
    const text = document.querySelector('div')!.firstChild!;
    const range = document.createRange();
    range.setStart(text, start);
    range.setEnd(text, end);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  };

  it('formats a selection without document.execCommand', () => {
    select(0, 5);
    expect(toggleInlineFormat('bold')).toBe(true);
    expect(document.querySelector('strong')?.textContent).toBe('hello');
  });

  it('inserts text and reports active formats', () => {
    select(5, 5);
    expect(insertTextAtSelection(' vivid')).toBe(true);
    expect(document.querySelector('div')?.textContent).toContain('hello vivid world');
    select(0, 5);
    toggleInlineFormat('italic');
    expect(getActiveRichTextFormats().italic).toBe(true);
  });

  it('creates an accessible unordered list structure', () => {
    select(0, 5);
    expect(toggleUnorderedList()).toBe(true);
    expect(document.querySelector('ul > li')?.textContent).toBe('hello');
  });
});
