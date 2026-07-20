import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadEnv } from 'vite';

const root = process.cwd();
const dist = path.join(root, 'dist');
const mode = process.env.VITE_MODE?.trim() || 'production';
const environment = { ...loadEnv(mode, root, ''), ...process.env };
const releaseBuild = process.env.DEAR_DIARY_RELEASE_BUILD === 'true';
const failures = [];

const appEnvironments = new Set(['development', 'staging', 'production']);
const appEnvironment = environment.VITE_APP_ENV?.trim();
if (!appEnvironment || !appEnvironments.has(appEnvironment)) {
  failures.push('VITE_APP_ENV must be development, staging, or production.');
} else if (appEnvironment !== mode) {
  failures.push(`VITE_APP_ENV=${appEnvironment} does not match the Vite mode ${mode}.`);
}

const walk = async (directory) =>
  (
    await Promise.all(
      (await readdir(directory, { withFileTypes: true })).map(async (entry) => {
        const absolute = path.join(directory, entry.name);
        return entry.isDirectory() ? walk(absolute) : [absolute];
      }),
    )
  ).flat();

const files = await walk(dist);
if (files.some((file) => file.endsWith('.map'))) failures.push('Public source maps are forbidden.');

const textArtifacts = files.filter((file) => /\.(?:js|cjs|html|css)$/.test(file));
const artifactText = (await Promise.all(textArtifacts.map((file) => readFile(file, 'utf8')))).join(
  '\n',
);
if (/sourceMappingURL=/.test(artifactText)) failures.push('Source-map references are forbidden.');
if (/VITE_ENABLE_MD_FLOW_HOOKS|deardiary-manual-test-checkpoint/.test(artifactText)) {
  failures.push('Manual test hooks are present in the production artifact.');
}
if (/VITE_DEAR_DIARY_E2E|E2E Sanitizer Probe/.test(artifactText)) {
  failures.push('E2E seed hooks are present in the production artifact.');
}

const runtimeFlags = await readFile(path.join(root, 'src/sync/runtimeFlags.ts'), 'utf8');
for (const flag of [
  'automaticGarbageCollectionEnabled',
  'snapshotCreationEnabled',
  'keyRotationEnabled',
  'deviceRevocationEnabled',
  'primaryRecoveryEnabled',
]) {
  if (!new RegExp(`${flag}: false`).test(runtimeFlags))
    failures.push(`${flag} must default to false.`);
}

for (const variable of ['CAPACITOR_WEBVIEW_DEBUG', 'CAPACITOR_DEBUG', 'CAPACITOR_BRIDGE_LOGGING']) {
  if (environment[variable] === 'true') failures.push(`${variable} must not be enabled.`);
}
if (environment.VITE_DISABLE_ENCRYPTION === 'true') failures.push('Encryption cannot be disabled.');
if (environment.VITE_USE_MOCK_AUTH === 'true')
  failures.push('Mock authentication cannot be enabled.');
const backendUrl = environment.VITE_SYNC_V2_API_URL || environment.VITE_BACKEND_URL;
if (
  appEnvironment !== 'development' &&
  /localhost|127\.0\.0\.1|\.local(?:\/|$)/i.test(backendUrl || '')
) {
  failures.push('Development backend URLs are forbidden.');
}

if (releaseBuild) {
  for (const variable of [
    'VITE_SUPABASE_URL',
    'VITE_SUPABASE_ANON_KEY',
    'VITE_SYNC_V2_API_URL',
    'VITE_MINIMUM_PROTOCOL_VERSION',
    'VITE_TELEMETRY_RELEASE_VERSION',
  ]) {
    if (!environment[variable]?.trim())
      failures.push(`${variable} is required for release builds.`);
  }
}

if (failures.length > 0) {
  console.error('Production configuration validation failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}
console.log('Production configuration validation passed.');
