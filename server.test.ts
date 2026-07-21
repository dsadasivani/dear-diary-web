import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import request from 'supertest';

process.env.DEAR_DIARY_DISABLE_SERVER_AUTOSTART = 'true';
const { contentSecurityPolicy, createApp } = await import('./server.ts');

const createDist = async () => {
  const distPath = await mkdtemp(path.join(os.tmpdir(), 'dear-diary-dist-'));
  await writeFile(
    path.join(distPath, 'index.html'),
    '<!doctype html><title>Dear Diary</title><div id="root"></div>',
  );
  await writeFile(path.join(distPath, 'app.js'), 'window.__dearDiaryTest = true;');
  return distPath;
};

test('GET /api/health returns JSON health status', async () => {
  const app = await createApp({ mode: 'production', distPath: await createDist() });
  const response = await request(app).get('/api/health').expect(200);

  assert.match(response.headers['content-type'], /application\/json/);
  assert.deepEqual(response.body, { status: 'ok', offline: true });
});

test('production responses include a restrictive browser security policy', async () => {
  const app = await createApp({ mode: 'production', distPath: await createDist() });
  const response = await request(app).get('/').expect(200);

  assert.match(response.headers['content-security-policy'], /default-src 'self'/);
  assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.match(response.headers['content-security-policy'], /object-src 'none'/);
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['x-frame-options'], 'DENY');
  assert.equal(response.headers['referrer-policy'], 'strict-origin-when-cross-origin');
  assert.equal(response.headers['cross-origin-opener-policy'], 'same-origin-allow-popups');
  assert.match(response.headers['permissions-policy'], /geolocation=\(\)/);
  assert.match(response.headers['strict-transport-security'], /max-age=31536000/);
  assert.equal(response.headers['x-powered-by'], undefined);
});

test('development policy permits Vite runtime features without weakening production scripts', () => {
  const developmentPolicy = contentSecurityPolicy(
    'development',
    'http://localhost:8080/api/v2/sync',
    'http://localhost:9000/dear-diary-sync',
  );
  const productionPolicy = contentSecurityPolicy(
    'production',
    'http://localhost:8080/api/v2/sync',
    'http://localhost:9000/dear-diary-sync',
  );

  assert.match(developmentPolicy, /connect-src[^;]+ws:/);
  assert.match(developmentPolicy, /connect-src[^;]+http:\/\/localhost:8080/);
  assert.match(developmentPolicy, /connect-src[^;]+http:\/\/localhost:9000/);
  assert.match(developmentPolicy, /script-src[^;]*'unsafe-inline'/);
  assert.doesNotMatch(productionPolicy, /connect-src[^;]+ ws:/);
  assert.doesNotMatch(productionPolicy, /connect-src[^;]+localhost:8080/);
  assert.doesNotMatch(productionPolicy, /connect-src[^;]+localhost:9000/);
  assert.doesNotMatch(productionPolicy, /script-src[^;]*'unsafe-inline'/);
});

test('unknown API routes return JSON 404 instead of the SPA shell', async () => {
  const app = await createApp({ mode: 'production', distPath: await createDist() });
  const response = await request(app).get('/api/missing').expect(404);

  assert.match(response.headers['content-type'], /application\/json/);
  assert.deepEqual(response.body, { error: 'not_found' });
});

test('production app serves static assets and falls back to the SPA shell', async () => {
  const distPath = await createDist();
  const app = await createApp({ mode: 'production', distPath });

  const asset = await request(app).get('/app.js').expect(200);
  assert.match(asset.text, /__dearDiaryTest/);

  const fallback = await request(app).get('/diaries/today').expect(200);
  assert.match(fallback.text, /Dear Diary/);
});

test('static serving does not expose files outside the dist directory', async () => {
  const app = await createApp({ mode: 'production', distPath: await createDist() });
  const response = await request(app).get('/..%2Fpackage.json').expect(200);

  assert.match(response.text, /Dear Diary/);
  assert.doesNotMatch(response.text, /"dependencies"/);
});

test('oversized JSON bodies are rejected with 413', async () => {
  const app = await createApp({
    mode: 'production',
    distPath: await createDist(),
    jsonLimit: '1kb',
  });
  const response = await request(app)
    .post('/api/health')
    .send({ payload: 'x'.repeat(2_000) })
    .expect(413);

  assert.deepEqual(response.body, { error: 'payload_too_large' });
});

test('malformed JSON returns a controlled client error', async () => {
  const app = await createApp({ mode: 'production', distPath: await createDist() });
  const response = await request(app)
    .post('/api/health')
    .set('Content-Type', 'application/json')
    .send('{not json')
    .expect(400);

  assert.deepEqual(response.body, { error: 'invalid_json' });
});
