import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fullSuitePaths = new Set([
  '.github/workflows/ci.yml',
  'package.json',
  'package-lock.json',
  'scripts/detect-ci-scope.mjs',
  'scripts/detect-ci-scope.test.mjs',
]);

const webFiles = new Set([
  'index.html',
  'server.ts',
  'server.test.ts',
  'vite.config.ts',
  'vitest.config.ts',
  'vitest.setup.ts',
  'tsconfig.json',
  '.env.development',
  '.env.staging',
  '.env.production',
  'scripts/validate-production-config.mjs',
]);

const operationsFiles = new Set([
  'amplify.yml',
  'customHttp.yml',
  'scripts/validate-ops-config.mjs',
  'scripts/verify-web-deployment.mjs',
  'scripts/secret-and-artifact-scan.mjs',
]);

const createEmptyScope = () => ({
  backend: false,
  web: false,
  browser: false,
  android: false,
});

export const classifyCiScope = (changedPaths) => {
  const scope = createEmptyScope();
  const unclassified = [];
  let full = false;

  for (const rawPath of changedPaths) {
    const changedPath = rawPath.replaceAll('\\', '/');
    let recognized = false;

    if (fullSuitePaths.has(changedPath)) {
      full = true;
      recognized = true;
    }

    if (
      changedPath.startsWith('backend/sync-api/') ||
      changedPath === 'scripts/run-backend-gradle.mjs'
    ) {
      scope.backend = true;
      recognized = true;
    }

    if (
      changedPath.startsWith('src/') ||
      changedPath.startsWith('public/') ||
      webFiles.has(changedPath)
    ) {
      scope.web = true;
      scope.browser = true;
      recognized = true;
    }

    if (changedPath.startsWith('tests/e2e/') || changedPath === 'playwright.config.ts') {
      scope.browser = true;
      recognized = true;
    }

    if (
      changedPath.startsWith('android/') ||
      changedPath.startsWith('resources/') ||
      changedPath.startsWith('src/mobile/') ||
      changedPath === 'capacitor.config.ts' ||
      changedPath === 'scripts/run-gradle.mjs'
    ) {
      scope.android = true;
      recognized = true;
    }

    if (
      changedPath.startsWith('ops/') ||
      changedPath.startsWith('.github/workflows/') ||
      operationsFiles.has(changedPath)
    ) {
      recognized = true;
    }

    if (
      changedPath.endsWith('.md') ||
      changedPath.startsWith('docs/') ||
      changedPath.endsWith('.png') ||
      changedPath.endsWith('.xml') ||
      changedPath === '.gitignore'
    ) {
      recognized = true;
    }

    if (!recognized) {
      unclassified.push(changedPath);
      full = true;
    }
  }

  if (full) {
    for (const key of Object.keys(scope)) scope[key] = true;
  }

  return { scope, full, unclassified };
};

const run = () => {
  const [baseSha, headSha] = process.argv.slice(2);
  if (!baseSha || !headSha) {
    throw new Error('Usage: node scripts/detect-ci-scope.mjs <base-sha> <head-sha>');
  }

  const changedPaths = execFileSync('git', ['diff', '--name-only', baseSha, headSha], {
    encoding: 'utf8',
  })
    .split(/\r?\n/)
    .filter(Boolean);
  const { scope, full, unclassified } = classifyCiScope(changedPaths);

  for (const changedPath of unclassified) {
    console.log(`Unclassified path requires full CI: ${changedPath}`);
  }

  const output = Object.entries(scope)
    .map(([name, enabled]) => `${name}=${enabled}`)
    .join('\n');
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${output}\n`);
  else console.log(output);

  if (process.env.GITHUB_STEP_SUMMARY) {
    const summary = [
      '## CI scope',
      '',
      `- Full suite: \`${full}\``,
      ...Object.entries(scope).map(([name, enabled]) => `- ${name}: \`${enabled}\``),
      '',
      '<details><summary>Changed files</summary>',
      '',
      '```text',
      ...changedPaths,
      '```',
      '</details>',
      '',
    ].join('\n');
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }
};

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) run();
