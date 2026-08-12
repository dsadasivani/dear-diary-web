#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (!argument.startsWith('--')) continue;
  const [key, inlineValue] = argument.slice(2).split('=');
  const value =
    inlineValue ?? (process.argv[index + 1]?.startsWith('--') ? 'true' : process.argv[index + 1]);
  args.set(key, value ?? 'true');
  if (inlineValue === undefined && value !== 'true') index += 1;
}

const integerArg = (name, fallback) => {
  const value = Number(args.get(name) ?? fallback);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid --${name} value.`);
  return value;
};
const booleanArg = (name, fallback = false) => {
  const value = args.get(name);
  if (value === undefined) return fallback;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new Error(`Invalid --${name} value.`);
};

const appId = args.get('app-id') || 'com.deardiary.app';
const serial = args.get('serial') || process.env.ANDROID_SERIAL || 'emulator-5554';
const adb = args.get('adb') || 'adb';
const devtoolsPort = integerArg('devtools-port', 9222);
const expectedNotes = integerArg('expected-notes', 10_000);
const seed = booleanArg('seed');
const seedEntries = integerArg('seed-entries', 1);
const runs = Math.max(1, integerArg('runs', 3));
const timeoutMs = Math.max(10_000, integerArg('timeout-ms', 300_000));
const thresholds = {
  initialP95Ms: integerArg('max-initial-p95-ms', 2_000),
  searchP95Ms: integerArg('max-search-p95-ms', 2_000),
  loadMoreP95Ms: integerArg('max-load-more-p95-ms', 2_000),
  createMs: integerArg('max-create-ms', 3_000),
  editMs: integerArg('max-edit-ms', 3_000),
  heapGrowthBytes: integerArg('max-heap-growth-mb', 64) * 1024 * 1024,
};
const pin = process.env.DEAR_DIARY_BENCHMARK_PIN || '';
const output = args.get('output') ? resolve(args.get('output')) : undefined;

const runAdb = (...commandArgs) => {
  const result = spawnSync(adb, ['-s', serial, ...commandArgs], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `adb ${commandArgs.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result.stdout.trim();
};

const sleep = (milliseconds) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
const percentile = (values, rank) => {
  const sorted = [...values].sort((left, right) => left - right);
  return (
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((rank / 100) * sorted.length) - 1))] ||
    0
  );
};
const summarize = (values) => ({
  minMs: Math.round(Math.min(...values)),
  p50Ms: Math.round(percentile(values, 50)),
  p95Ms: Math.round(percentile(values, 95)),
  maxMs: Math.round(Math.max(...values)),
});

runAdb('shell', 'monkey', '-p', appId, '-c', 'android.intent.category.LAUNCHER', '1');
let pid = '';
const processDeadline = Date.now() + 30_000;
while (!pid && Date.now() < processDeadline) {
  pid = runAdb('shell', 'pidof', appId);
  if (!pid) await sleep(250);
}
if (!pid) throw new Error(`${appId} did not start on ${serial}.`);
runAdb('forward', `tcp:${devtoolsPort}`, `localabstract:webview_devtools_remote_${pid}`);

const endpoint = `http://127.0.0.1:${devtoolsPort}`;
const endpointDeadline = Date.now() + 30_000;
while (Date.now() < endpointDeadline) {
  try {
    const response = await fetch(`${endpoint}/json`);
    if (response.ok && (await response.json()).length > 0) break;
  } catch {
    // WebView debugging starts shortly after the Android process.
  }
  await sleep(250);
}

const browser = await chromium.connectOverCDP(endpoint);
const context = browser.contexts()[0];
const page = context?.pages()[0];
if (!page) throw new Error('No Android WebView page was exposed through Chrome debugging.');
page.setDefaultTimeout(Math.min(timeoutMs, 30_000));

const unlockIfNeeded = async () => {
  let body = await page.locator('body').innerText();
  if (body.includes('TAP TO UNLOCK')) {
    await page.getByText('TAP TO UNLOCK').click();
    await page
      .getByText('Enter PIN', { exact: true })
      .waitFor({ state: 'visible', timeout: 5_000 });
    body = await page.locator('body').innerText();
  }
  if (body.includes('Enter PIN')) {
    if (!pin) throw new Error('Set DEAR_DIARY_BENCHMARK_PIN to unlock the benchmark installation.');
    for (const digit of pin) await page.getByRole('button', { name: digit, exact: true }).click();
    await page.getByRole('button', { name: /unlock/i }).click();
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const today = page.getByText('Today', { exact: true }).last();
    if (await today.isVisible().catch(() => false)) return;
    const offline = page.getByRole('button', { name: 'Use offline copy' });
    if (await offline.isVisible().catch(() => false)) await offline.click();
    await sleep(250);
  }
  throw new Error('The app did not finish unlocking before the benchmark timeout.');
};

const dismissSyncOverlay = async () => {
  const offline = page.getByRole('button', { name: 'Use offline copy' });
  if (await offline.isVisible().catch(() => false)) await offline.click();
};

await unlockIfNeeded();
await dismissSyncOverlay();

if (seed) {
  await page.waitForFunction(() => Boolean(window.__loredaysManualPerformance), undefined, {
    timeout: 30_000,
  });
  const seeded = await page.evaluate(
    async ({ entries, notes }) =>
      window.__loredaysManualPerformance.seedFiveYearHistory({
        diaries: 25,
        entries,
        notes,
        publishSync: false,
        createRestorePoint: false,
        fastNotesOnly: true,
      }),
    { entries: seedEntries, notes: expectedNotes },
  );
  if (seeded.notes !== expectedNotes) throw new Error(`Seed produced ${seeded.notes} notes.`);
}

const cdp = await context.newCDPSession(page);
const heapBefore = await cdp.send('Runtime.getHeapUsage');
const timings = { initial: [], search: [], loadMore: [] };

const openNotes = async () => {
  await dismissSyncOverlay();
  const search = page.getByRole('textbox', { name: 'Search notes' });
  if (await search.isVisible().catch(() => false)) {
    await page.getByText('Today', { exact: true }).last().click();
  }
  const startedAt = Date.now();
  await page.getByText('Notes', { exact: true }).last().click();
  await page.getByTestId('note-card').first().waitFor({ state: 'visible', timeout: timeoutMs });
  timings.initial.push(Date.now() - startedAt);
  const initialCards = await page.getByTestId('note-card').count();
  if (initialCards !== 40)
    throw new Error(`Expected 40 initial note cards, found ${initialCards}.`);
  const summary = await page.locator('.open-page-notes-summary').innerText();
  if (!summary.startsWith(`${expectedNotes} `)) {
    throw new Error(`Expected ${expectedNotes} notes, found summary "${summary}".`);
  }
};

for (let run = 0; run < runs; run += 1) {
  await openNotes();
  const search = page.getByRole('textbox', { name: 'Search notes' });
  const targetTitle = `Long-history note ${expectedNotes - 1}`;
  let startedAt = Date.now();
  await search.fill(targetTitle);
  await page
    .getByText(targetTitle, { exact: true })
    .waitFor({ state: 'visible', timeout: timeoutMs });
  timings.search.push(Date.now() - startedAt);
  if ((await page.getByTestId('note-card').count()) !== 1) {
    throw new Error('Targeted full-text search did not return exactly one note.');
  }
  await search.fill('');
  const loadMore = page.getByRole('button', {
    name: new RegExp(`Load more \\(40 of ${expectedNotes}\\)`),
  });
  await loadMore.waitFor({ state: 'visible', timeout: timeoutMs });
  startedAt = Date.now();
  await loadMore.click();
  await page
    .getByRole('button', { name: new RegExp(`Load more \\(80 of ${expectedNotes}\\)`) })
    .waitFor({ state: 'visible', timeout: timeoutMs });
  timings.loadMore.push(Date.now() - startedAt);
  if ((await page.getByTestId('note-card').count()) !== 80) {
    throw new Error('The second page did not produce exactly 80 rendered note cards.');
  }
}

await openNotes();
const validationTitle = 'Scale CRUD validation cedar orchid';
let startedAt = Date.now();
await page.getByRole('button', { name: 'New Note' }).click();
await page.getByTestId('note-title-input').fill(validationTitle);
await page.getByTestId('quick-note-editor').fill('Temporary Android scale benchmark note.');
await page.getByRole('button', { name: 'Save Note' }).click();
await page
  .getByRole('textbox', { name: 'Search notes' })
  .waitFor({ state: 'visible', timeout: timeoutMs });
const createMs = Date.now() - startedAt;

const search = page.getByRole('textbox', { name: 'Search notes' });
await search.fill('cedar orchid');
await page
  .getByText(validationTitle, { exact: true })
  .waitFor({ state: 'visible', timeout: timeoutMs });
await page.getByText(validationTitle, { exact: true }).click();
const editedTitle = `${validationTitle} edited`;
await page.getByTestId('note-title-input').fill(editedTitle);
startedAt = Date.now();
await page.getByRole('button', { name: 'Save Changes' }).click();
await page
  .getByRole('textbox', { name: 'Search notes' })
  .waitFor({ state: 'visible', timeout: timeoutMs });
await search.fill('cedar orchid edited');
await page
  .getByText(editedTitle, { exact: true })
  .waitFor({ state: 'visible', timeout: timeoutMs });
const editMs = Date.now() - startedAt;

await page.getByText(editedTitle, { exact: true }).click();
await page.getByTestId('note-delete-button').click();
await page.getByTestId('note-confirm-delete-button').click();
await page
  .getByRole('textbox', { name: 'Search notes' })
  .waitFor({ state: 'visible', timeout: timeoutMs });
await page.getByRole('textbox', { name: 'Search notes' }).fill('');
await page
  .getByRole('button', { name: new RegExp(`Load more \\(40 of ${expectedNotes}\\)`) })
  .waitFor({ state: 'visible', timeout: timeoutMs });

const heapAfter = await cdp.send('Runtime.getHeapUsage');
const report = {
  generatedAt: new Date().toISOString(),
  device: { serial, appId, pid: Number(pid) },
  fixture: {
    notes: expectedNotes,
    seedMode: seed ? 'notes-only' : 'existing',
    existingEntriesPreserved: true,
    seeded: seed,
  },
  runs,
  timings: {
    initial: summarize(timings.initial),
    search: summarize(timings.search),
    loadMore: summarize(timings.loadMore),
    createMs,
    editMs,
  },
  rendering: { initialCards: 40, secondPageCards: 80 },
  heap: {
    beforeBytes: heapBefore.usedSize,
    afterBytes: heapAfter.usedSize,
    growthBytes: heapAfter.usedSize - heapBefore.usedSize,
  },
  thresholds,
};

const failures = [];
if (report.timings.initial.p95Ms > thresholds.initialP95Ms) failures.push('initial p95');
if (report.timings.search.p95Ms > thresholds.searchP95Ms) failures.push('search p95');
if (report.timings.loadMore.p95Ms > thresholds.loadMoreP95Ms) failures.push('load-more p95');
if (createMs > thresholds.createMs) failures.push('create');
if (editMs > thresholds.editMs) failures.push('edit');
if (report.heap.growthBytes > thresholds.heapGrowthBytes) failures.push('heap growth');
report.passed = failures.length === 0;
report.failures = failures;

if (output) {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}
console.log(JSON.stringify(report, null, 2));
await browser.close();
if (!report.passed) throw new Error(`Notes benchmark exceeded: ${failures.join(', ')}.`);
