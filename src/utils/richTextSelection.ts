export interface ActiveRichTextFormats {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikeThrough: boolean;
  h2: boolean;
  blockquote: boolean;
  list: boolean;
}

const editableRootFor = (node: Node | null): HTMLElement | null => {
  const element = node instanceof Element ? node : node?.parentElement;
  return element?.closest<HTMLElement>('[contenteditable="true"]') || null;
};

const activeRange = (): Range | null => {
  const selection = window.getSelection();
  return selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
};

const moveCursorAfter = (node: Node): void => {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
};

const notifyInput = (node: Node | null, inputType: string, data?: string): void => {
  const root = editableRootFor(node);
  root?.dispatchEvent(new InputEvent('input', { bubbles: true, inputType, data: data ?? null }));
};

const selectedAncestor = (tagName: string): HTMLElement | null => {
  const range = activeRange();
  const element =
    range?.commonAncestorContainer instanceof Element
      ? range.commonAncestorContainer
      : range?.commonAncestorContainer.parentElement;
  const match = element?.closest<HTMLElement>(tagName) || null;
  const root = editableRootFor(range?.commonAncestorContainer || null);
  return match && root?.contains(match) ? match : null;
};

const unwrap = (element: HTMLElement): void => {
  const parent = element.parentNode;
  if (!parent) return;
  while (element.firstChild) parent.insertBefore(element.firstChild, element);
  parent.removeChild(element);
  notifyInput(parent, 'formatRemove');
};

export const insertTextAtSelection = (text: string): boolean => {
  const range = activeRange();
  if (!range) return false;
  const root = editableRootFor(range.commonAncestorContainer);
  if (!root) return false;
  range.deleteContents();
  const textNode = document.createTextNode(text);
  range.insertNode(textNode);
  moveCursorAfter(textNode);
  notifyInput(textNode, 'insertText', text);
  return true;
};

export const insertHtmlAtSelection = (html: string): boolean => {
  const range = activeRange();
  if (!range) return false;
  const root = editableRootFor(range.commonAncestorContainer);
  if (!root) return false;
  range.deleteContents();
  const fragment = range.createContextualFragment(html);
  const last = fragment.lastChild;
  range.insertNode(fragment);
  if (last) moveCursorAfter(last);
  notifyInput(root, 'insertFromPaste');
  return true;
};

const INLINE_TAGS: Record<string, keyof HTMLElementTagNameMap> = {
  bold: 'strong',
  italic: 'em',
  underline: 'u',
  strikeThrough: 's',
};

export const toggleInlineFormat = (format: keyof typeof INLINE_TAGS): boolean => {
  const tagName = INLINE_TAGS[format];
  const existing = selectedAncestor(tagName);
  if (existing) {
    unwrap(existing);
    return true;
  }
  const range = activeRange();
  if (!range || !editableRootFor(range.commonAncestorContainer)) return false;
  const wrapper = document.createElement(tagName);
  if (range.collapsed) {
    wrapper.append(document.createTextNode('\u200B'));
    range.insertNode(wrapper);
    const selection = window.getSelection();
    const cursor = document.createRange();
    cursor.selectNodeContents(wrapper);
    cursor.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(cursor);
  } else {
    wrapper.append(range.extractContents());
    range.insertNode(wrapper);
    const selection = window.getSelection();
    const formattedRange = document.createRange();
    formattedRange.selectNodeContents(wrapper);
    selection?.removeAllRanges();
    selection?.addRange(formattedRange);
  }
  notifyInput(wrapper, 'formatSetBlockTextDirection');
  return true;
};

export const toggleBlockFormat = (tagName: 'h2' | 'blockquote'): boolean => {
  const range = activeRange();
  if (!range || !editableRootFor(range.commonAncestorContainer)) return false;
  const existing = selectedAncestor(tagName);
  if (existing) {
    const paragraph = document.createElement('p');
    paragraph.append(...Array.from(existing.childNodes));
    existing.replaceWith(paragraph);
    notifyInput(paragraph, 'formatBlock');
    return true;
  }
  const block = document.createElement(tagName);
  if (range.collapsed) block.append(document.createElement('br'));
  else block.append(range.extractContents());
  range.insertNode(block);
  moveCursorAfter(block);
  notifyInput(block, 'formatBlock');
  return true;
};

export const toggleUnorderedList = (): boolean => {
  const existing = selectedAncestor('ul');
  if (existing) {
    const fragment = document.createDocumentFragment();
    existing.querySelectorAll(':scope > li').forEach((item) => {
      const paragraph = document.createElement('p');
      paragraph.append(...Array.from(item.childNodes));
      fragment.append(paragraph);
    });
    const parent = existing.parentNode;
    existing.replaceWith(fragment);
    notifyInput(parent, 'insertUnorderedList');
    return true;
  }
  const range = activeRange();
  if (!range || !editableRootFor(range.commonAncestorContainer)) return false;
  const list = document.createElement('ul');
  const item = document.createElement('li');
  if (range.collapsed) item.append(document.createElement('br'));
  else item.append(range.extractContents());
  list.append(item);
  range.insertNode(list);
  moveCursorAfter(list);
  notifyInput(list, 'insertUnorderedList');
  return true;
};

export const getActiveRichTextFormats = (): ActiveRichTextFormats => ({
  bold: Boolean(selectedAncestor('strong, b')),
  italic: Boolean(selectedAncestor('em, i')),
  underline: Boolean(selectedAncestor('u')),
  strikeThrough: Boolean(selectedAncestor('s, strike')),
  h2: Boolean(selectedAncestor('h2')),
  blockquote: Boolean(selectedAncestor('blockquote')),
  list: Boolean(selectedAncestor('ul')),
});
