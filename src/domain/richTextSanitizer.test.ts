import assert from 'node:assert/strict';
import test from 'node:test';
import { richTextHtmlToPlainText, sanitizeEntry, sanitizeNote, sanitizeRichTextHtml } from './richTextSanitizer';

test('preserves editor-supported rich text while removing attributes', () => {
  assert.equal(
    sanitizeRichTextHtml('<h2 class="hero">Title</h2><p style="color:red">Hello <strong data-x="1">world</strong><br></p>'),
    '<h2>Title</h2><p>Hello <strong>world</strong><br></p>',
  );
});

test('removes executable HTML, URLs, images, SVG, iframes, styles, and event handlers', () => {
  const sanitized = sanitizeRichTextHtml(`
    <p onclick="alert(1)">Safe</p>
    <a href="javascript:alert(1)">link</a>
    <img src=x onerror=alert(1)>
    <svg><script>alert(1)</script></svg>
    <iframe srcdoc="<script>alert(1)</script>"></iframe>
    <style>body{display:none}</style>
    <script>alert(1)</script>
  `);

  assert.match(sanitized, /<p>Safe<\/p>/);
  assert.match(sanitized, /link/);
  assert.doesNotMatch(sanitized, /onclick|javascript:|img|svg|iframe|style|script|onerror|srcdoc/i);
});

test('removes dangerous rich-text payload variants without leaking executable text', () => {
  const payloads = [
    '<math><mtext><script>alert(1)</script></mtext></math>',
    '<object data="javascript:alert(1)">fallback</object>',
    '<embed src="javascript:alert(1)">',
    '<p><ScRiPt>alert(1)</ScRiPt>Visible</p>',
    '<div><span id="constructor">clobber</span><form name="body">form</form></div>',
    '<iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe><p>After</p>',
    '<p><img src=x OnErRoR=alert(1)>Image text</p>',
    '<p><a href="javas&#99;ript:alert(1)" onclick="alert(1)">Encoded</a></p>',
    '<svg><style>*{display:none}</style><foreignObject><p>hidden</p></foreignObject></svg><p>Shown</p>',
    '<div><b>Nested <i>safe</i></b><style>@import url(javascript:alert(1))</style></div>',
  ];

  payloads.forEach(payload => {
    const sanitized = sanitizeRichTextHtml(payload);
    assert.doesNotMatch(
      sanitized,
      /script|iframe|svg|math|object|embed|style|img|onerror|onclick|javascript:|srcdoc|id=|name=/i,
      `payload was not fully sanitized: ${payload}`,
    );
  });
});

test('sanitizes entry, block, and note bodies', () => {
  const entry = sanitizeEntry({
    id: 'entry-1',
    diaryId: 'diary-1',
    date: '2026-07-08',
    title: 'Entry',
    body: '<p>Body<img src=x onerror=alert(1)></p>',
    moodName: 'Calm',
    moodEmoji: '',
    tags: [],
    photoUris: [],
    photoCount: 0,
    wordCount: 1,
    createdAt: 1,
    updatedAt: 1,
    blocks: [{ id: 'block-1', time: '10:00', body: '<script>alert(1)</script><strong onclick=alert(1)>ok</strong>' }],
  });
  const note = sanitizeNote({
    id: 'note-1',
    title: 'Note',
    body: '<div style="x:1">Note<script>alert(1)</script></div>',
    isPinned: false,
    tags: [],
    createdAt: 1,
    updatedAt: 1,
  });

  assert.equal(entry.body, '<p>Body</p>');
  assert.equal(entry.blocks?.[0].body, '<strong>ok</strong>');
  assert.equal(note.body, '<div>Note</div>');
});

test('converts rich text to visible plain text for search', () => {
  const plain = richTextHtmlToPlainText('<p>Hello <strong>visible</strong></p><script>hidden()</script><div>again</div>');
  assert.equal(plain, 'Hello visible again');
  assert.equal(plain.toLowerCase().includes('strong'), false);
  assert.equal(plain.toLowerCase().includes('script'), false);
});
