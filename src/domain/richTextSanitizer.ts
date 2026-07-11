import createDOMPurify from 'dompurify';
import type { Entry, EntryBlock, Note } from '../types';
import type { RepositorySnapshot } from '../repositories/DiaryRepository';

const ALLOWED_TAGS = [
  'p',
  'div',
  'br',
  'b',
  'strong',
  'i',
  'em',
  'u',
  's',
  'strike',
  'ul',
  'ol',
  'li',
  'blockquote',
  'h2',
] as const;

const ALLOWED_TAG_SET = new Set<string>(ALLOWED_TAGS);
const DROP_CONTENT_TAGS = new Set(['script', 'style', 'iframe', 'svg', 'math', 'object', 'embed']);

const escapeHtml = (value: string): string => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

const decodeBasicHtmlEntities = (value: string): string => value
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'");

const normalizePlainText = (value: string): string => value.replace(/\s+/g, ' ').trim();

const sanitizeWithFallback = (html: string): string => {
  let output = '';
  let skipTag = '';
  let skipDepth = 0;
  const tokens = html.match(/<!--[\s\S]*?-->|<![^>]*>|<\/?[^>]+>|[^<]+/g) || [];

  for (const token of tokens) {
    if (token.startsWith('<!--') || token.startsWith('<!')) continue;
    if (!token.startsWith('<')) {
      if (!skipTag) output += escapeHtml(token);
      continue;
    }

    const match = token.match(/^<\s*(\/?)\s*([a-zA-Z0-9:-]+)/);
    if (!match) {
      if (!skipTag) output += escapeHtml(token);
      continue;
    }

    const closing = Boolean(match[1]);
    const tag = match[2].toLowerCase();

    if (skipTag) {
      if (tag === skipTag) {
        skipDepth += closing ? -1 : 1;
        if (skipDepth <= 0) {
          skipTag = '';
          skipDepth = 0;
        }
      }
      continue;
    }

    if (!ALLOWED_TAG_SET.has(tag)) {
      if (!closing && DROP_CONTENT_TAGS.has(tag)) {
        skipTag = tag;
        skipDepth = 1;
      }
      continue;
    }

    if (tag === 'br') {
      if (!closing) output += '<br>';
      continue;
    }
    output += closing ? `</${tag}>` : `<${tag}>`;
  }

  return output;
};

const getBrowserWindow = (): Window | null => {
  if (typeof window !== 'undefined' && window.document) return window;
  const globalWindow = (globalThis as { window?: Window }).window;
  return globalWindow?.document ? globalWindow : null;
};

export const sanitizeRichTextHtml = (html: string | null | undefined): string => {
  if (!html) return '';
  const browserWindow = getBrowserWindow();
  if (!browserWindow) return sanitizeWithFallback(String(html));

  const purifier = createDOMPurify(browserWindow as unknown as Parameters<typeof createDOMPurify>[0]);
  return purifier.sanitize(String(html), {
    ALLOWED_TAGS: [...ALLOWED_TAGS],
    ALLOWED_ATTR: [],
    FORBID_ATTR: ['style', 'class', 'id'],
    KEEP_CONTENT: true,
    RETURN_TRUSTED_TYPE: false,
  });
};

export const richTextHtmlToPlainText = (html: string | null | undefined): string => {
  if (!html) return '';
  const sanitized = sanitizeRichTextHtml(html);
  const browserWindow = getBrowserWindow();
  if (browserWindow) {
    const container = browserWindow.document.createElement('div');
    container.innerHTML = sanitized
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/(p|div|li|blockquote|h2)>/gi, ' </$1>');
    return normalizePlainText(container.textContent || '');
  }

  const tokens = sanitized.match(/<\/?[^>]+>|[^<]+/g) || [];
  let output = '';
  for (const token of tokens) {
    if (!token.startsWith('<')) {
      output += decodeBasicHtmlEntities(token);
      continue;
    }
    if (/^<\s*br\s*\/?>$/i.test(token) || /^<\s*\/\s*(p|div|li|blockquote|h2)\s*>$/i.test(token)) {
      output += ' ';
    }
  }
  return normalizePlainText(output);
};

const sanitizeBlock = (block: EntryBlock): EntryBlock => ({
  ...block,
  body: sanitizeRichTextHtml(block.body),
});

export const sanitizeEntry = <T extends Entry>(entry: T): T => ({
  ...entry,
  body: sanitizeRichTextHtml(entry.body),
  blocks: entry.blocks?.map(sanitizeBlock),
});

export const sanitizeNote = <T extends Note>(note: T): T => ({
  ...note,
  body: sanitizeRichTextHtml(note.body),
});

export const sanitizeRepositorySnapshot = (snapshot: RepositorySnapshot): RepositorySnapshot => ({
  ...snapshot,
  entries: snapshot.entries.map(entry => sanitizeEntry(entry)),
  notes: snapshot.notes.map(note => sanitizeNote(note)),
});
